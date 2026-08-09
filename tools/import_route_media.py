#!/usr/bin/env python3
"""Inventory, route-map, and optimize a folder of Homedred Miler media."""

from __future__ import annotations

import argparse
import bisect
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import fitdecode
except ImportError as error:
    raise SystemExit("Install fitdecode first: python3 -m pip install fitdecode") from error


SEMICIRCLE_TO_DEGREES = 180 / 2**31
M_PER_MI = 1609.344
SUPPORTED_PHOTOS = {".jpg", ".jpeg"}
SUPPORTED_VIDEOS = {".mov", ".mp4", ".m4v"}
ISO6709 = re.compile(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?/")

ROUTE_REGIONS = [
    (0.0, "Golden Gate Park"),
    (4.1, "Presidio"),
    (5.9, "Golden Gate Bridge"),
    (10.8, "Marin Headlands"),
    (17.2, "Coastal Trail"),
    (22.9, "Mt Tam South Slope"),
    (26.9, "Dipsea Trail"),
    (43.5, "Bolinas Ridge"),
    (49.5, "Cross Marin Trail"),
    (65.0, "Kent Lake"),
    (76.1, "Mt Tam Watershed"),
    (80.5, "Mt Tam East Peak"),
    (82.8, "Mountain Home"),
    (88.9, "Muir Woods"),
    (94.1, "Marin Headlands Return"),
    (95.9, "Golden Gate Bridge Return"),
    (100.01, "San Francisco Return"),
]


def run(command: list[str]) -> str:
    return subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iso_utc(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_datetime(value: str | None) -> dt.datetime | None:
    if not value or value == "(null)":
        return None
    value = value.strip().strip('"')
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S %z")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    value = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(value))


def parse_mdls(path: Path) -> dict:
    fields = [
        "kMDItemContentCreationDate",
        "kMDItemLatitude",
        "kMDItemLongitude",
        "kMDItemPixelWidth",
        "kMDItemPixelHeight",
    ]
    command = ["mdls"]
    for field in fields:
        command.extend(["-name", field])
    command.append(str(path))
    values = {}
    for line in run(command).splitlines():
        if " = " not in line:
            continue
        key, value = line.split(" = ", 1)
        values[key.strip()] = value.strip()
    return {
        "captured": parse_datetime(values.get("kMDItemContentCreationDate")),
        "lat": number_or_none(values.get("kMDItemLatitude")),
        "lon": number_or_none(values.get("kMDItemLongitude")),
        "display_width": integer_or_none(values.get("kMDItemPixelWidth")),
        "display_height": integer_or_none(values.get("kMDItemPixelHeight")),
    }


def number_or_none(value: str | None) -> float | None:
    if not value or value == "(null)":
        return None
    return float(value)


def integer_or_none(value: str | None) -> int | None:
    if not value or value == "(null)":
        return None
    return int(value)


def parse_video(path: Path) -> dict:
    payload = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,size:format_tags",
                "-show_entries",
                "stream=codec_type,width,height:stream_side_data=rotation",
                "-of",
                "json",
                str(path),
            ]
        )
    )
    tags = payload["format"].get("tags", {})
    location = tags.get("com.apple.quicktime.location.ISO6709")
    match = ISO6709.fullmatch(location or "")
    video = next(stream for stream in payload["streams"] if stream.get("codec_type") == "video")
    rotation = next(
        (
            side_data.get("rotation", 0)
            for side_data in video.get("side_data_list", [])
            if "rotation" in side_data
        ),
        0,
    )
    width, height = int(video["width"]), int(video["height"])
    if abs(rotation) % 180 == 90:
        width, height = height, width
    captured = parse_datetime(
        tags.get("creation_time") or tags.get("com.apple.quicktime.creationdate")
    )
    return {
        "captured": captured,
        "lat": float(match.group(1)) if match else None,
        "lon": float(match.group(2)) if match else None,
        "display_width": width,
        "display_height": height,
        "duration": float(payload["format"]["duration"]),
        "source_size": int(payload["format"]["size"]),
    }


def load_activity(path: Path) -> tuple[list[tuple], str]:
    records = []
    with fitdecode.FitReader(str(path)) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage) or frame.name != "record":
                continue
            timestamp = frame.get_value("timestamp")
            lat = frame.get_value("position_lat")
            lon = frame.get_value("position_long")
            if timestamp is None or lat is None or lon is None:
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=dt.timezone.utc)
            records.append(
                (
                    timestamp,
                    lat * SEMICIRCLE_TO_DEGREES,
                    lon * SEMICIRCLE_TO_DEGREES,
                    frame.get_value("distance"),
                )
            )
    records.sort(key=lambda row: row[0])
    return records, sha256(path)


def interpolate_activity(records: list[tuple], captured: dt.datetime | None) -> dict | None:
    if captured is None or not records:
        return None
    captured = captured.astimezone(dt.timezone.utc)
    times = [record[0] for record in records]
    index = bisect.bisect_left(times, captured)
    if index == 0:
        delta = (records[0][0] - captured).total_seconds()
        if delta > 3600:
            return None
        return {
            "lat": records[0][1],
            "lon": records[0][2],
            "distance_m": records[0][3],
            "gap_s": delta,
            "endpoint": "start",
        }
    if index == len(records):
        delta = (captured - records[-1][0]).total_seconds()
        if delta > 3600:
            return None
        return {
            "lat": records[-1][1],
            "lon": records[-1][2],
            "distance_m": records[-1][3],
            "gap_s": delta,
            "endpoint": "finish",
        }
    left, right = records[index - 1], records[index]
    span = (right[0] - left[0]).total_seconds()
    if span <= 0 or span > 15:
        return None
    fraction = (captured - left[0]).total_seconds() / span
    distance = None
    if left[3] is not None and right[3] is not None:
        distance = left[3] + (right[3] - left[3]) * fraction
    return {
        "lat": left[1] + (right[1] - left[1]) * fraction,
        "lon": left[2] + (right[2] - left[2]) * fraction,
        "distance_m": distance,
        "gap_s": span,
        "endpoint": None,
    }


def route_candidates(course_points: list[list[float]], lat: float, lon: float) -> list[dict]:
    hits = sorted(
        (haversine(lat, lon, point[0], point[1]), index, point)
        for index, point in enumerate(course_points)
    )
    candidates = []
    for offset, index, point in hits:
        if all(abs(index - prior["index"]) > 100 for prior in candidates):
            candidates.append(
                {"offset_m": offset, "index": index, "mile": point[3], "point": point}
            )
        if len(candidates) == 8:
            break
    return candidates


def select_route_candidate(candidates: list[dict], expected_mile: float | None) -> dict:
    nearest = candidates[0]["offset_m"]
    plausible = [candidate for candidate in candidates if candidate["offset_m"] <= nearest + 80]
    if expected_mile is None:
        return plausible[0]
    return min(plausible, key=lambda candidate: abs(candidate["mile"] - expected_mile))


def region_for_mile(mile: float) -> str:
    for upper, name in ROUTE_REGIONS:
        if mile <= upper:
            return name
    return "Homedred Miler"


def even(value: float) -> int:
    rounded = max(2, int(round(value)))
    return rounded if rounded % 2 == 0 else rounded + 1


def output_dimensions(width: int, height: int, max_side: int) -> tuple[int, int]:
    scale = min(1, max_side / max(width, height))
    return even(width * scale), even(height * scale)


def inventory_item(
    path: Path,
    source_root: Path,
    activity_records: list[tuple],
    activity_hash: str,
    activity_path: Path,
    course_points: list[list[float]],
    course_total_mi: float,
    activity_total_m: float,
    override: dict | None,
) -> dict:
    extension = path.suffix.lower()
    media_type = "video" if extension in SUPPORTED_VIDEOS else "photo"
    metadata = parse_video(path) if media_type == "video" else parse_mdls(path)
    captured = metadata["captured"]
    activity = interpolate_activity(activity_records, captured)
    direct_position = metadata["lat"] is not None and metadata["lon"] is not None
    activity_delta = None
    if direct_position and activity:
        activity_delta = haversine(
            metadata["lat"], metadata["lon"], activity["lat"], activity["lon"]
        )
    embedded_is_stale = activity_delta is not None and activity_delta > 1500
    use_embedded = direct_position and not embedded_is_stale
    lat = metadata["lat"] if use_embedded else activity["lat"] if activity else None
    lon = metadata["lon"] if use_embedded else activity["lon"] if activity else None
    expected_mile = None
    if activity and activity["distance_m"] is not None and activity_total_m:
        expected_mile = activity["distance_m"] / activity_total_m * course_total_mi
    candidate = None
    if lat is not None and lon is not None:
        candidate = select_route_candidate(
            route_candidates(course_points, lat, lon), expected_mile
        )
    item_id = path.stem.lower().replace("_", "-")
    route_mile = candidate["mile"] if candidate else None
    region = region_for_mile(route_mile) if route_mile is not None else "Homedred Miler"
    title = override.get("title") if override else None
    alt = override.get("alt") if override else None
    title = title or f"{region} · mile {route_mile:.1f}" if route_mile is not None else path.stem
    if not alt:
        noun = "video" if media_type == "video" else "photo"
        alt = (
            f"Race {noun} captured in {region} near planned-route mile {route_mile:.1f}."
            if route_mile is not None
            else f"Race {noun} from the Homedred Miler."
        )
    outputs = (
        {
            "src": f"assets/media/{path.stem}.mp4",
            "thumbnailSrc": f"assets/media/{path.stem}-poster.jpg",
        }
        if media_type == "video"
        else {
            "src": f"assets/media/{path.stem}-full.jpg",
            "thumbnailSrc": f"assets/media/{path.stem}.jpg",
        }
    )
    if media_type == "video":
        output_width = min(720, metadata["display_width"])
        output_height = even(output_width * metadata["display_height"] / metadata["display_width"])
    else:
        output_width, output_height = output_dimensions(
            metadata["display_width"], metadata["display_height"], 2400
        )
    status = "resolved" if candidate and candidate["offset_m"] <= 1000 else "needs-review"
    if embedded_is_stale:
        location_source = "activity-match"
        confidence = "medium"
    elif use_embedded:
        location_source = "embedded-gps"
        confidence = "high" if activity_delta is None or activity_delta < 50 else "medium"
    elif activity:
        location_source = "activity-end" if activity["endpoint"] else "activity-match"
        confidence = "low" if activity["endpoint"] else "medium"
    else:
        location_source = "unknown"
        confidence = "unresolved"
    if activity and activity["endpoint"]:
        note = (
            f"Captured {activity['gap_s'] / 60:.1f} minutes after the FIT activity; "
            f"provisionally assigned to its {activity['endpoint']} location. "
            f"Nearest planned-route offset is {candidate['offset_m']:.1f} m."
        )
    elif embedded_is_stale:
        note = (
            f"Embedded GPS was {activity_delta:.1f} m from the FIT position and was treated "
            f"as stale; the FIT position was used. Nearest route offset is "
            f"{candidate['offset_m']:.1f} m."
        )
    elif candidate:
        note = (
            f"Matched to the FIT activity; planned-route visit selected using activity progress. "
            f"Nearest route offset is {candidate['offset_m']:.1f} m."
        )
    else:
        note = "Could not assign a route location automatically."
    return {
        "id": item_id,
        "sourcePath": str(path.relative_to(source_root)),
        "sourceHash": sha256(path),
        "type": media_type,
        "capturedAt": iso_utc(captured),
        "timestampSource": "quicktime" if media_type == "video" else "spotlight",
        "lat": round(lat, 7) if lat is not None else None,
        "lon": round(lon, 7) if lon is not None else None,
        "locationSource": location_source,
        "locationConfidence": confidence,
        "routeMi": round(route_mile, 4) if route_mile is not None else None,
        "routeOffsetM": round(candidate["offset_m"], 1) if candidate else None,
        "activitySource": str(activity_path),
        "activityHash": activity_hash,
        "activityLat": round(activity["lat"], 7) if activity else None,
        "activityLon": round(activity["lon"], 7) if activity else None,
        "activityGpsDeltaM": round(activity_delta, 1) if activity_delta is not None else None,
        "activityDistanceMi": round(activity["distance_m"] / M_PER_MI, 4) if activity and activity["distance_m"] is not None else None,
        "title": title,
        "alt": alt,
        "status": status,
        "durationSeconds": round(metadata.get("duration", 0), 3) if media_type == "video" else None,
        "width": output_width,
        "height": output_height,
        "mimeType": "video/mp4" if media_type == "video" else "image/jpeg",
        "notes": note,
        "outputs": outputs,
    }


def process_video(source: Path, item: dict, assets: Path, force: bool) -> str:
    output = assets / Path(item["outputs"]["src"]).name
    poster = assets / Path(item["outputs"]["thumbnailSrc"]).name
    if force or not output.exists():
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-vf",
                "scale=720:-2:flags=lanczos,fps=30",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "24",
                "-maxrate",
                "5M",
                "-bufsize",
                "10M",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                str(output),
            ],
            check=True,
        )
    if force or not poster.exists():
        midpoint = max(0, item["durationSeconds"] / 2)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-ss",
                str(midpoint),
                "-i",
                str(output),
                "-frames:v",
                "1",
                "-vf",
                "scale=720:-2:flags=lanczos",
                "-q:v",
                "3",
                "-update",
                "1",
                str(poster),
            ],
            check=True,
        )
    return item["id"]


def process_photo(source: Path, item: dict, assets: Path, force: bool) -> str:
    full = assets / Path(item["outputs"]["src"]).name
    thumbnail = assets / Path(item["outputs"]["thumbnailSrc"]).name
    commands = [
        (full, "2400", "82"),
        (thumbnail, "900", "78"),
    ]
    for output, max_side, quality in commands:
        if not force and output.exists():
            continue
        subprocess.run(
            [
                "sips",
                "--resampleHeightWidthMax",
                max_side,
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                quality,
                str(source),
                "--out",
                str(output),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    return item["id"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--fit", type=Path, required=True)
    parser.add_argument("--course", type=Path, default=Path("app/src/data/course.json"))
    parser.add_argument("--manifest", type=Path, default=Path("app/src/media-manifest.json"))
    parser.add_argument("--overrides", type=Path, default=Path("app/src/media-overrides.json"))
    parser.add_argument("--assets", type=Path, default=Path("app/src/assets/media"))
    parser.add_argument("--process", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()

    source_root = args.source.resolve()
    files = sorted(
        path
        for path in source_root.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_PHOTOS | SUPPORTED_VIDEOS
    )
    overrides = json.loads(args.overrides.read_text()) if args.overrides.exists() else {}
    activity_records, activity_hash = load_activity(args.fit)
    activity_distances = [
        record[3] for record in activity_records if record[3] is not None
    ]
    activity_total_m = max(activity_distances)
    course = json.loads(args.course.read_text())

    def inspect(path: Path) -> dict:
        item_id = path.stem.lower().replace("_", "-")
        return inventory_item(
            path,
            source_root,
            activity_records,
            activity_hash,
            args.fit,
            course["pts"],
            course["totalMi"],
            activity_total_m,
            overrides.get(item_id),
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
        items = list(executor.map(inspect, files))
    items.sort(key=lambda item: (item["capturedAt"] or "", item["sourcePath"]))

    seen_hashes = {}
    for item in items:
        if item["sourceHash"] in seen_hashes:
            item["status"] = "duplicate"
            item["notes"] = f"Exact duplicate of {seen_hashes[item['sourceHash']]}."
        else:
            seen_hashes[item["sourceHash"]] = item["id"]

    args.manifest.write_text(json.dumps(items, indent=2) + "\n")
    counts = {}
    for item in items:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    print(f"inventory={len(items)} counts={counts}")
    print(
        f"activity={activity_records[0][0].isoformat()}..{activity_records[-1][0].isoformat()} "
        f"distance={activity_total_m / M_PER_MI:.2f}mi"
    )

    if not args.process:
        return
    args.assets.mkdir(parents=True, exist_ok=True)
    resolved = [item for item in items if item["status"] == "resolved"]

    def convert(item: dict) -> str:
        source = source_root / item["sourcePath"]
        if item["type"] == "video":
            return process_video(source, item, args.assets, args.force)
        return process_photo(source, item, args.assets, args.force)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = {executor.submit(convert, item): item for item in resolved}
        for completed, future in enumerate(
            concurrent.futures.as_completed(futures), start=1
        ):
            item = futures[future]
            try:
                print(f"[{completed}/{len(futures)}] {future.result()}", flush=True)
            except Exception as error:
                print(f"FAILED {item['id']}: {error}", file=sys.stderr, flush=True)
                raise


if __name__ == "__main__":
    main()
