#!/usr/bin/env python3
"""Archive hourly NOAA temperature and wind fields for the activity.

Temperature is the observation-informed, 2.5 km NOAA/NWS Real-Time Mesoscale
Analysis (RTMA), rendered by NCSCO's public THREDDS WMS. Wind is the 3 km NOAA
HRRR field served by Open-Meteo and stored as a compact vector grid so Mapbox
can draw sharp arrows at every zoom. All upstream data is snapshotted here.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


UTC = dt.timezone.utc
USER_AGENT = "Homedred-Miler/1.0 (+https://homedred.pedrolab.org)"
WMS_ROOT = "https://thredds.climate.ncsu.edu/thredds/wms/ncep/rtma"
OPEN_METEO_ROOT = "https://historical-forecast-api.open-meteo.com/v1/forecast"
DEFAULT_IMAGE_SIZE = 512
RENDER_VERSION = "warm-native-vector-wind-20260811"

# Match the archived GOES tile for broad temperature context.
CONTEXT_BOUNDS = [-123.75, 36.59788913307021, -120.9375, 38.8225909761771]
# A tighter transparent footprint gives wind glyphs substantially more detail
# around the activity without pretending the 2.5 km source grid is finer.
ROUTE_BOUNDS = [-122.95, 37.62, -122.30, 38.20]

LAYER_CONFIG = {
    "temperature": {
        "label": "RTMA 2 m air temperature",
        "layer": "Temperature_height_above_ground",
        "style": "default-scalar/seq-YlOrRd",
        "elevation": "2",
        "colorScale": "278.15,308.15",
        "opacity": 0.58,
        "bounds": CONTEXT_BOUNDS,
        "legend": {
            "kind": "gradient",
            "min": "41",
            "mid": "68",
            "max": "95 °F",
            "description": "2 m air temperature",
        },
    },
    "wind": {
        "label": "HRRR 10 m wind",
        "renderType": "vectors",
        "opacity": 0.9,
        "bounds": ROUTE_BOUNDS,
        "legend": {
            "kind": "wind",
            "min": "0",
            "mid": "17",
            "max": "34+ mph",
            "description": "direction and speed at 10 m",
        },
    },
}


def parse_iso(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso_z(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_activity_window(activity_path: Path) -> tuple[dt.datetime, dt.datetime]:
    activity = json.loads(activity_path.read_text(encoding="utf-8"))
    summary = activity["summary"]
    start = parse_iso(summary["startAt"])
    finish = start + dt.timedelta(seconds=summary["elapsedS"])
    return start, finish


def analysis_hours(start: dt.datetime, finish: dt.datetime) -> list[dt.datetime]:
    cursor = start.replace(minute=0, second=0, microsecond=0)
    last = finish.replace(minute=0, second=0, microsecond=0)
    if last < finish:
        last += dt.timedelta(hours=1)
    values = []
    while cursor <= last:
        values.append(cursor)
        cursor += dt.timedelta(hours=1)
    return values


def mercator_bbox(bounds: list[float]) -> str:
    west, south, east, north = bounds
    radius = 6378137.0

    def x(lon: float) -> float:
        return radius * math.radians(lon)

    def y(lat: float) -> float:
        return radius * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    return ",".join(str(value) for value in (x(west), y(south), x(east), y(north)))


def wms_url(layer_key: str, valid_time: dt.datetime) -> str:
    config = LAYER_CONFIG[layer_key]
    image_size = config.get("imageSize", DEFAULT_IMAGE_SIZE)
    day_path = valid_time.strftime("%Y%m/%Y%m%d")
    filename = f"rtma2p5.t{valid_time:%H}z.2dvaranl_ndfd.grb2"
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "CRS": "EPSG:3857",
        "BBOX": mercator_bbox(config["bounds"]),
        "WIDTH": str(image_size),
        "HEIGHT": str(image_size),
        "FORMAT": "image/png",
        "TRANSPARENT": "TRUE",
        "TIME": valid_time.strftime("%Y-%m-%dT%H:00:00.000Z"),
        "NUMCOLORBANDS": "80",
        "LAYERS": config["layer"],
        "STYLES": config["style"],
        "ELEVATION": config["elevation"],
        "COLORSCALERANGE": config["colorScale"],
    }
    if "vectorSpacing" in config:
        params["VECTORSPACING"] = config["vectorSpacing"]
    return f"{WMS_ROOT}/{day_path}/{filename}?{urllib.parse.urlencode(params)}"


def wind_sample_points(bounds: list[float], step_degrees: float = 0.03) -> list[tuple[float, float]]:
    west, south, east, north = bounds
    points = []
    latitude = south + step_degrees / 2
    while latitude < north:
        longitude = west + step_degrees / 2
        while longitude < east:
            points.append((round(latitude, 5), round(longitude, 5)))
            longitude += step_degrees
        latitude += step_degrees
    return points


def fetch_wind_vectors(
    hours: list[dt.datetime],
    bounds: list[float],
) -> dict[dt.datetime, list[list[float]]]:
    points = wind_sample_points(bounds)
    hour_by_key = {value.strftime("%Y-%m-%dT%H:%M"): value for value in hours}
    vectors_by_time = {value: [] for value in hours}

    for batch_start in range(0, len(points), 50):
        batch = points[batch_start:batch_start + 50]
        params = {
            "latitude": ",".join(str(latitude) for latitude, _ in batch),
            "longitude": ",".join(str(longitude) for _, longitude in batch),
            "start_date": hours[0].date().isoformat(),
            "end_date": hours[-1].date().isoformat(),
            "hourly": "wind_speed_10m,wind_direction_10m",
            "models": "ncep_hrrr_conus",
            "wind_speed_unit": "mph",
            "timezone": "GMT",
        }
        request = urllib.request.Request(
            f"{OPEN_METEO_ROOT}?{urllib.parse.urlencode(params)}",
            headers={"User-Agent": USER_AGENT},
        )
        payload = None
        error: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    payload = json.load(response)
                break
            except Exception as caught:
                error = caught
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
        if payload is None:
            raise RuntimeError(f"Open-Meteo wind batch failed: {error}") from error
        if isinstance(payload, dict):
            payload = [payload]
        if len(payload) != len(batch):
            raise RuntimeError(
                f"Open-Meteo returned {len(payload)} locations for {len(batch)} requests"
            )

        for (latitude, longitude), location in zip(batch, payload):
            hourly = location.get("hourly", {})
            times = hourly.get("time", [])
            speeds = hourly.get("wind_speed_10m", [])
            directions = hourly.get("wind_direction_10m", [])
            for time_key, speed, direction in zip(times, speeds, directions):
                valid_time = hour_by_key.get(time_key)
                if valid_time is None or speed is None or direction is None:
                    continue
                # Open-Meteo reports the meteorological source direction.
                # Rotate 180 degrees so the displayed arrow points downwind.
                bearing = (float(direction) + 180) % 360
                vectors_by_time[valid_time].append(
                    [
                        round(longitude, 5),
                        round(latitude, 5),
                        round(float(speed), 1),
                        round(bearing),
                    ]
                )
    return vectors_by_time


def archive_wind_vectors(
    hours: list[dt.datetime],
    start: dt.datetime,
    output: Path,
) -> tuple[dict, list[dict]]:
    config = LAYER_CONFIG["wind"]
    vectors_by_time = fetch_wind_vectors(hours, config["bounds"])
    frames = []
    failures = []
    for valid_time in hours:
        vectors = vectors_by_time.get(valid_time, [])
        if not vectors:
            failures.append(
                {"time": iso_z(valid_time), "error": "No HRRR wind vectors returned"}
            )
            continue
        frames.append(
            {
                "time": iso_z(valid_time),
                "activityElapsedS": round((valid_time - start).total_seconds()),
                "vectors": vectors,
            }
        )
    if not frames:
        raise RuntimeError("No wind vector frames could be archived")

    # Remove superseded WMS arrow rasters. Wind now remains resolution-independent
    # as a compact point grid rendered by Mapbox.
    raster_dir = output / "wind" / "frames"
    if raster_dir.exists():
        for path in raster_dir.glob("*.png"):
            path.unlink()
        try:
            raster_dir.rmdir()
            raster_dir.parent.rmdir()
        except OSError:
            pass

    return {
        "kind": "wind",
        "renderType": "vectors",
        "label": config["label"],
        "description": (
            "Hourly NOAA HRRR 10 m wind sampled on a regular route-area grid "
            "and rendered as resolution-independent map arrows."
        ),
        "caveat": (
            "Model analysis, not a measurement at every arrow. Arrows point "
            "downwind; color and size represent speed."
        ),
        "expectedCadenceS": 3600,
        "opacity": config["opacity"],
        "bounds": config["bounds"],
        "resolutionKm": 3,
        "legend": config["legend"],
        "source": {
            "data": "NOAA/NCEP High-Resolution Rapid Refresh (HRRR)",
            "service": "Open-Meteo Historical Forecast API",
            "url": "https://open-meteo.com/",
        },
        "frames": frames,
        "gaps": [],
        "failedFrames": failures,
    }, failures


def download_frame(
    layer_key: str,
    valid_time: dt.datetime,
    destination: Path,
    refresh: bool,
) -> dict:
    if destination.exists() and destination.stat().st_size > 0 and not refresh:
        return {"time": valid_time, "path": destination}

    request = urllib.request.Request(
        wms_url(layer_key, valid_time),
        headers={"User-Agent": USER_AGENT},
    )
    error: Exception | None = None
    for attempt in range(3):
        temp_path = None
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = response.read()
            if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
                detail = payload[:240].decode("utf-8", errors="replace")
                raise RuntimeError(f"Unexpected WMS response: {detail}")
            with tempfile.NamedTemporaryFile(
                prefix=f"{destination.stem}-",
                suffix=".png",
                dir=destination.parent,
                delete=False,
            ) as output:
                output.write(payload)
                temp_path = Path(output.name)
            os.replace(temp_path, destination)
            return {"time": valid_time, "path": destination}
        except Exception as caught:
            error = caught
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{layer_key} {iso_z(valid_time)} failed: {error}") from error


def archive_layer(
    layer_key: str,
    hours: list[dt.datetime],
    start: dt.datetime,
    output: Path,
    jobs: int,
    refresh: bool,
) -> tuple[dict, list[dict]]:
    config = LAYER_CONFIG[layer_key]
    frames_dir = output / layer_key / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    completed: list[dict] = []
    failures: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as executor:
        future_to_time = {
            executor.submit(
                download_frame,
                layer_key,
                valid_time,
                frames_dir / f"{valid_time:%Y%m%dT%H%M%SZ}.png",
                refresh,
            ): valid_time
            for valid_time in hours
        }
        for future in concurrent.futures.as_completed(future_to_time):
            valid_time = future_to_time[future]
            try:
                completed.append(future.result())
            except Exception as error:
                failures.append({"time": iso_z(valid_time), "error": str(error)})

    completed.sort(key=lambda frame: frame["time"])
    if not completed:
        raise RuntimeError(f"No {layer_key} frames could be archived")

    frames = [
        {
            "time": iso_z(frame["time"]),
            "activityElapsedS": round((frame["time"] - start).total_seconds()),
            "url": (
                f"/weather/{layer_key}/frames/{frame['path'].name}"
                f"?v={RENDER_VERSION}"
            ),
        }
        for frame in completed
    ]
    gaps = []
    for left, right in zip(completed, completed[1:]):
        seconds = round((right["time"] - left["time"]).total_seconds())
        if seconds > 3600:
            gaps.append(
                {
                    "from": iso_z(left["time"]),
                    "to": iso_z(right["time"]),
                    "seconds": seconds,
                }
            )

    layer_manifest = {
        "kind": layer_key,
        "label": config["label"],
        "description": (
            "Observation-informed NOAA/NWS surface weather analysis at 2.5 km "
            "spatial resolution and hourly cadence."
        ),
        "caveat": (
            "Gridded analysis, not a measurement at every pixel. Coastal and "
            "terrain-scale conditions can vary within one grid cell."
        ),
        "expectedCadenceS": 3600,
        "opacity": config["opacity"],
        "bounds": config["bounds"],
        "legend": config["legend"],
        "frames": frames,
        "gaps": gaps,
        "failedFrames": failures,
    }
    return layer_manifest, failures


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
        default=Path("app/public/weather"),
        help="Static weather archive output directory.",
    )
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    start, finish = load_activity_window(args.activity)
    hours = analysis_hours(start, finish)
    print(
        f"Archiving {len(hours)} hourly RTMA analyses "
        f"from {iso_z(hours[0])} to {iso_z(hours[-1])}"
    )

    layers = {}
    failures = {}
    for layer_key in LAYER_CONFIG:
        if layer_key == "wind":
            layers[layer_key], failures[layer_key] = archive_wind_vectors(
                hours,
                start,
                args.output,
            )
        else:
            layers[layer_key], failures[layer_key] = archive_layer(
                layer_key,
                hours,
                start,
                args.output,
                args.jobs,
                args.refresh,
            )
        print(
            f"{layer_key}: {len(layers[layer_key]['frames'])} frames, "
            f"{len(failures[layer_key])} failures"
        )

    manifest = {
        "version": 2,
        "renderVersion": RENDER_VERSION,
        "kind": "surfaceWeatherAnalysis",
        "activityStartAt": iso_z(start),
        "activityFinishAt": iso_z(finish),
        "sourceStartAt": iso_z(hours[0]),
        "sourceFinishAt": iso_z(hours[-1]),
        "bounds": CONTEXT_BOUNDS,
        "resolutionKm": 2.5,
        "source": {
            "data": "NOAA/NWS/NCEP Real-Time Mesoscale Analysis (RTMA)",
            "renderer": "North Carolina State Climate Office THREDDS WMS",
            "url": "https://registry.opendata.aws/noaa-rtma/",
            "rendererUrl": "https://thredds.climate.ncsu.edu/thredds/catalog/ncep/rtma/catalog.html",
        },
        "layers": layers,
        "generatedAt": iso_z(dt.datetime.now(UTC)),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
