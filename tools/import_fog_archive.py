#!/usr/bin/env python3
"""Archive GOES-18 fog probability frames for the activity timeline.

The source product is NOAA's GOES-West Fog/Low Stratus IFR probability,
distributed as public map tiles by UW-Madison SSEC RealEarth. The tiles are
short-lived upstream, so this script snapshots the activity window into the
app's static public directory.

Requires ffmpeg for the transparent, muted blue rendering.
"""

from __future__ import annotations

import argparse
import bisect
import concurrent.futures
import datetime as dt
import json
import math
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path


PRODUCT = "G18-L2-CONUS-FLS-IFR"
TEXTURE_PRODUCT = "G18-ABI-CONUS-geo-color"
API_ROOT = "https://realearth.ssec.wisc.edu"
USER_AGENT = "Homedred-Miler/1.0 (+https://homedred.pedrolab.org)"
UTC = dt.timezone.utc

# One RealEarth z7 tile covers the entire activity, with useful coastal context.
TILE_Z = 7
TILE_X = 20
TILE_Y = 49

# Remove the product's black zero/no-data field, then convert its warm
# probability ramp into a restrained blue monochrome.
FFMPEG_FILTER = (
    "colorkey=0x000000:0.08:0.08,"
    "colorchannelmixer="
    "rr=.083:rg=.279:rb=.028:"
    "gr=.111:gg=.372:gb=.037:"
    "br=.130:bg=.436:bb=.044,"
    "gblur=sigma=2.2:steps=2"
)
TEXTURE_FILTER = (
    "[0:v]colorkey=0x000000:0.08:0.08,"
    "alphaextract,gblur=sigma=2.2:steps=2[prob];"
    "[1:v]format=gray,"
    "lut=y='clip((val-105)*2.2,0,255)',"
    "gblur=sigma=0.45[cloud];"
    "[prob][cloud]blend=all_mode=multiply[mask];"
    "color=c=0x63849b:s=256x256:d=1[color];"
    "[color][mask]alphamerge[out]"
)


def parse_iso(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_realearth_time(value: str) -> dt.datetime:
    return dt.datetime.strptime(value, "%Y%m%d.%H%M%S").replace(tzinfo=UTC)


def iso_z(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def tile_bounds(z: int, x: int, y: int) -> list[float]:
    scale = 1 << z

    def latitude(row: int) -> float:
        mercator = math.pi * (1 - 2 * row / scale)
        return math.degrees(math.atan(math.sinh(mercator)))

    return [
        x / scale * 360 - 180,
        latitude(y + 1),
        (x + 1) / scale * 360 - 180,
        latitude(y),
    ]


def load_activity_window(activity_path: Path) -> tuple[dt.datetime, dt.datetime]:
    activity = json.loads(activity_path.read_text())
    summary = activity["summary"]
    start = parse_iso(summary["startAt"])
    finish = start + dt.timedelta(seconds=summary["elapsedS"])
    return start, finish


def available_times(product: str) -> list[dt.datetime]:
    time_url = f"{API_ROOT}/api/times?products={product}"
    request = urllib.request.Request(time_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    return sorted(parse_realearth_time(value) for value in payload.get(product, []))


def nearest_time(
    values: list[dt.datetime],
    target: dt.datetime,
    maximum_difference_s: int = 360,
) -> dt.datetime | None:
    index = bisect.bisect_left(values, target)
    candidates = values[max(0, index - 1):min(len(values), index + 1)]
    if not candidates:
        return None
    nearest = min(candidates, key=lambda value: abs(value - target))
    if abs((nearest - target).total_seconds()) > maximum_difference_s:
        return None
    return nearest


def frame_url(product: str, frame_time: dt.datetime) -> str:
    day = frame_time.strftime("%Y%m%d")
    clock = frame_time.strftime("%H%M%S")
    return (
        f"{API_ROOT}/tiles/{product}/{day}/{clock}/"
        f"{TILE_Z}/{TILE_X}/{TILE_Y}.png"
    )


def download_tile(product: str, frame_time: dt.datetime, destination: Path) -> None:
    request = urllib.request.Request(
        frame_url(product, frame_time),
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        destination.write_bytes(response.read())
    if not destination.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError(f"Unexpected {product} response for {iso_z(frame_time)}")


def render_frame(
    frame_time: dt.datetime,
    texture_time: dt.datetime | None,
    frames_dir: Path,
    ffmpeg: str,
    refresh: bool,
) -> dict:
    stem = frame_time.strftime("%Y%m%dT%H%M%SZ")
    destination = frames_dir / f"{stem}.png"
    if destination.exists() and destination.stat().st_size > 0 and not refresh:
        return {
            "time": frame_time,
            "textureTime": texture_time,
            "path": destination,
        }

    with tempfile.TemporaryDirectory(prefix="homedred-fog-") as temp_dir:
        source = Path(temp_dir) / "source.png"
        texture = Path(temp_dir) / "texture.png"
        rendered = Path(temp_dir) / "rendered.png"
        download_tile(PRODUCT, frame_time, source)
        if texture_time is not None:
            download_tile(TEXTURE_PRODUCT, texture_time, texture)
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-i",
                str(texture),
                "-filter_complex",
                TEXTURE_FILTER,
                "-map",
                "[out]",
            ]
        else:
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-vf",
                FFMPEG_FILTER,
            ]
        subprocess.run(
            [
                *command,
                "-frames:v",
                "1",
                "-threads",
                "1",
                str(rendered),
            ],
            check=True,
        )
        os.replace(rendered, destination)
    return {
        "time": frame_time,
        "textureTime": texture_time,
        "path": destination,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--activity",
        type=Path,
        default=Path("app/src/data/activity.json"),
        help="Activity JSON used to determine the UTC playback window.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("app/public/fog"),
        help="Static fog archive output directory.",
    )
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to render transparent fog frames")

    start, finish = load_activity_window(args.activity)
    all_times = available_times(PRODUCT)
    texture_times = available_times(TEXTURE_PRODUCT)
    # Include the closest frame on either side when available so the endpoints
    # of the activity remain represented.
    selected = [
        value
        for value in all_times
        if start - dt.timedelta(minutes=5) <= value <= finish + dt.timedelta(minutes=5)
    ]
    if not selected:
        raise SystemExit(f"No {PRODUCT} frames found from {iso_z(start)} to {iso_z(finish)}")

    frames_dir = args.output / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"Archiving {len(selected)} {PRODUCT} frames "
        f"from {iso_z(selected[0])} to {iso_z(selected[-1])}"
    )

    completed: list[dict] = []
    failures: list[tuple[dt.datetime, Exception]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
        future_to_time = {
            executor.submit(
                render_frame,
                value,
                nearest_time(texture_times, value),
                frames_dir,
                ffmpeg,
                args.refresh,
            ): value
            for value in selected
        }
        for index, future in enumerate(concurrent.futures.as_completed(future_to_time), 1):
            value = future_to_time[future]
            try:
                completed.append(future.result())
            except Exception as error:  # Keep recoverable upstream gaps explicit.
                failures.append((value, error))
            if index % 25 == 0 or index == len(selected):
                print(f"[{index}/{len(selected)}] downloaded")

    completed.sort(key=lambda frame: frame["time"])
    if not completed:
        raise SystemExit("No fog frames could be downloaded")

    frame_entries = []
    for frame in completed:
        value = frame["time"]
        frame_entries.append(
            {
                "time": iso_z(value),
                "activityElapsedS": round((value - start).total_seconds()),
                "textureTime": (
                    iso_z(frame["textureTime"])
                    if frame["textureTime"] is not None
                    else None
                ),
                "url": f"/fog/frames/{frame['path'].name}",
            }
        )

    gaps = []
    for left, right in zip(completed, completed[1:]):
        seconds = round((right["time"] - left["time"]).total_seconds())
        if seconds > 15 * 60:
            gaps.append(
                {
                    "from": iso_z(left["time"]),
                    "to": iso_z(right["time"]),
                    "seconds": seconds,
                }
            )

    manifest = {
        "version": 1,
        "kind": "fogProbability",
        "product": PRODUCT,
        "label": "GOES-18 textured IFR fog probability",
        "description": (
            "High-resolution GOES-18 cloud texture constrained by the probability "
            "of instrument-flight-rule fog or low stratus, estimated from satellite "
            "observations and numerical weather model data."
        ),
        "caveat": (
            "Satellite and model estimate, not ground truth. Elevated low cloud can "
            "look like surface fog, and higher cloud can obscure conditions below."
        ),
        "activityStartAt": iso_z(start),
        "activityFinishAt": iso_z(finish),
        "sourceStartAt": frame_entries[0]["time"],
        "sourceFinishAt": frame_entries[-1]["time"],
        "expectedCadenceS": 300,
        "bounds": tile_bounds(TILE_Z, TILE_X, TILE_Y),
        "tile": {"z": TILE_Z, "x": TILE_X, "y": TILE_Y},
        "source": {
            "data": "NOAA/NESDIS GOES-18 ABI Fog/Low Stratus",
            "texture": "NOAA/NESDIS GOES-18 ABI GeoColor",
            "tiles": "UW-Madison SSEC RealEarth",
            "url": "https://realearth.ssec.wisc.edu/",
            "terms": "https://www.ssec.wisc.edu/realearth/terms-of-use/",
        },
        "frames": frame_entries,
        "gaps": gaps,
        "failedFrames": [
            {"time": iso_z(value), "error": str(error)}
            for value, error in failures
        ],
        "generatedAt": iso_z(dt.datetime.now(UTC)),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {args.output / 'manifest.json'} with {len(frame_entries)} frames, "
        f"{len(gaps)} source gaps, and {len(failures)} failed downloads"
    )


if __name__ == "__main__":
    main()
