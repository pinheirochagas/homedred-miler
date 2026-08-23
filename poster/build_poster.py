#!/usr/bin/env python3
"""Build the print-ready Homedred Miler route poster."""

from __future__ import annotations

import base64
import bisect
import html
import json
import math
import sys
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POSTER_DIR = ROOT / "poster"
ACTIVITY_PATH = ROOT / "app" / "src" / "data" / "activity.json"
SUMMARY_PATH = ROOT / "app" / "src" / "data" / "activity-summary.json"

PAGE_W = 420.0
PAGE_H = 594.0
MAP_X = 18.0
MAP_Y = 108.0
MAP_W = 384.0
MAP_H = 292.0
PROFILE_X = 28.0
PROFILE_Y = 447.0
PROFILE_W = 364.0
PROFILE_H = 72.0

PAPER = "#f7f7f3"
INK = "#111111"
MUTED = "#747471"
QUIET = "#a6a6a0"
MAP_BASE = "#e5e8e6"
TERRAIN = "#deded8"
HAIR = "#c8c8c2"
YELLOW = "#e8eb54"

M_PER_MI = 1609.344
FT_PER_M = 3.28084
WEB_MERCATOR_RADIUS_M = 6_378_137.0
SCALE_DISTANCE_MI = 5.0


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def world_xy(lon: float, lat: float) -> tuple[float, float]:
    lat_rad = math.radians(max(-85.05112878, min(85.05112878, lat)))
    return (
        (lon + 180.0) / 360.0,
        (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0,
    )


def latitude_from_world_y(world_y: float) -> float:
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * world_y))))


def point_line_distance(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if dx == 0 and dy == 0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    ratio = (
        (point[0] - start[0]) * dx + (point[1] - start[1]) * dy
    ) / (dx * dx + dy * dy)
    ratio = max(0.0, min(1.0, ratio))
    nearest = (start[0] + ratio * dx, start[1] + ratio * dy)
    return math.hypot(point[0] - nearest[0], point[1] - nearest[1])


def simplify(
    points: list[tuple[float, float]],
    tolerance: float,
) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    first = points[0]
    last = points[-1]
    max_distance = 0.0
    split_index = 0
    for index in range(1, len(points) - 1):
        distance = point_line_distance(points[index], first, last)
        if distance > max_distance:
            max_distance = distance
            split_index = index
    if max_distance <= tolerance:
        return [first, last]
    left = simplify(points[: split_index + 1], tolerance)
    right = simplify(points[split_index:], tolerance)
    return left[:-1] + right


def path_data(points: list[tuple[float, float]], close: bool = False) -> str:
    if not points:
        return ""
    command = [f"M {points[0][0]:.3f} {points[0][1]:.3f}"]
    command.extend(f"L {x:.3f} {y:.3f}" for x, y in points[1:])
    if close:
        command.append("Z")
    return " ".join(command)


def rolling_mean(values: list[float], radius: int) -> list[float]:
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + value)
    smoothed = []
    for index in range(len(values)):
        low = max(0, index - radius)
        high = min(len(values), index + radius + 1)
        smoothed.append((prefix[high] - prefix[low]) / (high - low))
    return smoothed


def tile_bytes(z: int, x: int, y: int) -> bytes:
    url = (
        "https://a.basemaps.cartocdn.com/"
        f"light_nolabels/{z}/{x}/{y}@2x.png"
    )
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Homedred-Miler-Poster/1.0 "
            "(https://homedred.pedrolab.org)"
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read()


def load_activity() -> tuple[dict, list[list[float]]]:
    activity = json.loads(ACTIVITY_PATH.read_text())
    overrides = json.loads(SUMMARY_PATH.read_text())
    summary = {**activity["summary"], **overrides}
    return summary, activity["track"]


def interpolate_track(
    track: list[list[float]],
    raw_distances: list[float],
    display_mi: float,
    distance_scale: float,
) -> tuple[float, float, float]:
    target_raw_m = display_mi * M_PER_MI / distance_scale
    index = bisect.bisect_left(raw_distances, target_raw_m)
    if index <= 0:
        sample = track[0]
        return sample[0], sample[1], sample[2]
    if index >= len(track):
        sample = track[-1]
        return sample[0], sample[1], sample[2]
    a = track[index - 1]
    b = track[index]
    span = b[3] - a[3]
    ratio = 0.0 if span == 0 else (target_raw_m - a[3]) / span
    return (
        a[0] + (b[0] - a[0]) * ratio,
        a[1] + (b[1] - a[1]) * ratio,
        a[2] + (b[2] - a[2]) * ratio,
    )


def build_svg() -> str:
    summary, track = load_activity()
    raw_distances = [sample[3] for sample in track]
    distance_scale = summary["distanceM"] / raw_distances[-1]
    total_mi = summary["distanceM"] / M_PER_MI

    route_world = [world_xy(sample[0], sample[1]) for sample in track]
    route_min_x = min(point[0] for point in route_world)
    route_max_x = max(point[0] for point in route_world)
    route_min_y = min(point[1] for point in route_world)
    route_max_y = max(point[1] for point in route_world)
    range_x = route_max_x - route_min_x
    range_y = route_max_y - route_min_y
    padded = (
        route_min_x - range_x * 0.095,
        route_min_y - range_y * 0.08,
        route_max_x + range_x * 0.095,
        route_max_y + range_y * 0.08,
    )

    map_scale = min(
        MAP_W / (padded[2] - padded[0]),
        MAP_H / (padded[3] - padded[1]),
    )
    map_center_x = (padded[0] + padded[2]) / 2.0
    map_center_y = (padded[1] + padded[3]) / 2.0

    def map_point(world_x: float, world_y: float) -> tuple[float, float]:
        return (
            MAP_X + MAP_W / 2.0 + (world_x - map_center_x) * map_scale,
            MAP_Y + MAP_H / 2.0 + (world_y - map_center_y) * map_scale,
        )

    route_page = [map_point(*point) for point in route_world]
    route_page = simplify(route_page, 0.075)

    landmark_specs = [
        (0.0, "HOME", 13.0, 12.0, "start"),
        (5.7, "GOLDEN GATE", 14.0, -3.0, "start"),
        (10.7, "RODEO BEACH", -14.0, 5.0, "end"),
        (17.1, "MUIR BEACH", -13.0, -4.0, "end"),
        (27.0, "STINSON BEACH", -13.0, -5.0, "end"),
        (44.2, "BOLINAS RIDGE", -13.0, -5.0, "end"),
        (66.1, "SKY OAKS", 13.0, -5.0, "start"),
        (77.9, "EAST PEAK", 13.0, -4.0, "start"),
        (85.2, "MUIR WOODS", 13.0, 7.0, "start"),
    ]

    landmarks = []
    for mile, label, dx, dy, anchor in landmark_specs:
        lon, lat, altitude_m = interpolate_track(
            track, raw_distances, mile, distance_scale
        )
        x, y = map_point(*world_xy(lon, lat))
        landmarks.append(
            {
                "mile": mile,
                "label": label,
                "x": x,
                "y": y,
                "dx": dx,
                "dy": dy,
                "anchor": anchor,
                "altitude_ft": altitude_m * FT_PER_M,
            }
        )

    parts: list[str] = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{PAGE_W}mm" height="{PAGE_H}mm" '
        f'viewBox="0 0 {PAGE_W} {PAGE_H}" role="img" '
        f'aria-label="Homedred Miler route and elevation poster">'
    )
    parts.append(
        f"""
        <defs>
          <clipPath id="map-clip">
            <rect x="{MAP_X}" y="{MAP_Y}" width="{MAP_W}" height="{MAP_H}"/>
          </clipPath>
          <style>
            text {{
              font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
              fill: {INK};
            }}
            .display {{ font-weight: 100; letter-spacing: -0.045em; }}
            .utility {{ font-weight: 400; letter-spacing: 0.13em; }}
            .map-label {{
              font-size: 3.9px;
              font-weight: 550;
              letter-spacing: 0.08em;
              paint-order: stroke;
              stroke: {PAPER};
              stroke-width: 1.75px;
              stroke-linejoin: round;
            }}
          </style>
        </defs>
        <rect width="{PAGE_W}" height="{PAGE_H}" fill="{PAPER}"/>
        """
    )

    parts.append(
        f'<text x="28" y="22" class="utility" font-size="4.0" '
        f'fill="{MUTED}">AUG 8–9, 2026</text>'
    )
    parts.append(
        f'<text x="392" y="22" class="utility" font-size="4.0" '
        f'text-anchor="end" fill="{MUTED}">SAN FRANCISCO / MARIN</text>'
    )
    parts.append(
        f'<text x="27" y="61" class="display" font-size="29.5">'
        f'HOMEDRED MILER</text>'
    )
    parts.append(
        f'<text x="28" y="78.5" font-size="5.2" font-weight="300" '
        f'letter-spacing="0.02em">A 100-MILE TRAIL RUNNING ADVENTURE</text>'
    )
    parts.append(
        f'<text x="392" y="78.5" font-size="5.2" font-weight="300" '
        f'text-anchor="end">'
        f'102.43 MI&#160;&#160;·&#160;&#160;+17,871 FT'
        f'&#160;&#160;·&#160;&#160;25:38:04</text>'
    )
    parts.append(
        f'<line x1="28" y1="91" x2="392" y2="91" '
        f'stroke="{INK}" stroke-width="0.35"/>'
    )

    parts.append(f'<g clip-path="url(#map-clip)">')
    parts.append(
        f'<rect x="{MAP_X}" y="{MAP_Y}" width="{MAP_W}" height="{MAP_H}" '
        f'fill="{MAP_BASE}"/>'
    )
    zoom = 11
    tile_count = 2**zoom
    visible_world = (
        map_center_x - MAP_W / (2.0 * map_scale),
        map_center_y - MAP_H / (2.0 * map_scale),
        map_center_x + MAP_W / (2.0 * map_scale),
        map_center_y + MAP_H / (2.0 * map_scale),
    )
    tile_min_x = math.floor(visible_world[0] * tile_count)
    tile_max_x = math.floor(visible_world[2] * tile_count)
    tile_min_y = math.floor(visible_world[1] * tile_count)
    tile_max_y = math.floor(visible_world[3] * tile_count)

    tile_failures = 0
    for tile_y in range(tile_min_y, tile_max_y + 1):
        for tile_x in range(tile_min_x, tile_max_x + 1):
            try:
                encoded = base64.b64encode(
                    tile_bytes(zoom, tile_x, tile_y)
                ).decode("ascii")
            except Exception as error:  # keep poster generation resilient
                tile_failures += 1
                print(
                    f"warning: could not load tile {tile_x}/{tile_y}: {error}",
                    file=sys.stderr,
                )
                continue
            x0, y0 = map_point(tile_x / tile_count, tile_y / tile_count)
            x1, y1 = map_point(
                (tile_x + 1) / tile_count,
                (tile_y + 1) / tile_count,
            )
            parts.append(
                f'<image x="{x0:.3f}" y="{y0:.3f}" '
                f'width="{x1 - x0:.3f}" height="{y1 - y0:.3f}" '
                f'opacity="0.52" preserveAspectRatio="none" '
                f'href="data:image/png;base64,{encoded}"/>'
            )
    if tile_failures:
        parts.append(
            f'<rect x="{MAP_X}" y="{MAP_Y}" width="{MAP_W}" '
            f'height="{MAP_H}" fill="{PAPER}" opacity="0.18"/>'
        )
    else:
        parts.append(
            f'<rect x="{MAP_X}" y="{MAP_Y}" width="{MAP_W}" '
            f'height="{MAP_H}" fill="{PAPER}" opacity="0.24"/>'
        )

    route_d = path_data(route_page)
    parts.append(
        f'<path d="{route_d}" fill="none" stroke="{PAPER}" '
        f'stroke-width="3.15" stroke-linecap="round" '
        f'stroke-linejoin="round"/>'
    )
    parts.append(
        f'<path d="{route_d}" fill="none" stroke="{INK}" '
        f'stroke-width="1.45" stroke-linecap="round" '
        f'stroke-linejoin="round"/>'
    )
    parts.append("</g>")

    for landmark in landmarks:
        x = landmark["x"]
        y = landmark["y"]
        text_x = x + landmark["dx"]
        text_y = y + landmark["dy"]
        line_end_x = text_x + (-2.2 if landmark["anchor"] == "end" else 2.2)
        parts.append(
            f'<line x1="{x:.2f}" y1="{y:.2f}" '
            f'x2="{line_end_x:.2f}" y2="{text_y - 1.0:.2f}" '
            f'stroke="{INK}" stroke-width="0.3"/>'
        )
        parts.append(
            f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.15" '
            f'fill="{YELLOW}" stroke="{INK}" stroke-width="0.45"/>'
        )
        parts.append(
            f'<text x="{text_x:.2f}" y="{text_y:.2f}" '
            f'class="map-label" text-anchor="{landmark["anchor"]}">'
            f'{esc(landmark["label"])}</text>'
        )
        parts.append(
            f'<text x="{text_x:.2f}" y="{text_y + 5.0:.2f}" '
            f'font-size="3.25" font-weight="450" fill="{MUTED}" '
            f'text-anchor="{landmark["anchor"]}" '
            f'paint-order="stroke" stroke="{PAPER}" stroke-width="1.45">'
            f'MI {landmark["mile"]:.1f}</text>'
        )

    start_x = landmarks[0]["x"]
    start_y = landmarks[0]["y"]
    parts.append(
        f'<circle cx="{start_x:.2f}" cy="{start_y:.2f}" r="4.0" '
        f'fill="none" stroke="{INK}" stroke-width="0.55"/>'
    )
    parts.append(
        f'<text x="389" y="118" font-size="3.8" '
        f'class="utility" text-anchor="end">N</text>'
    )
    parts.append(
        f'<line x1="389" y1="123" x2="389" y2="139" '
        f'stroke="{INK}" stroke-width="0.45"/>'
    )
    parts.append(
        f'<path d="M 389 120 L 386.7 125 L 391.3 125 Z" fill="{INK}"/>'
    )

    scale_x = MAP_X + 16
    scale_y = MAP_Y + MAP_H - 15
    scale_world_y = map_center_y + (
        scale_y - (MAP_Y + MAP_H / 2.0)
    ) / map_scale
    scale_lat = latitude_from_world_y(scale_world_y)
    ground_m_per_world_unit = (
        2.0
        * math.pi
        * WEB_MERCATOR_RADIUS_M
        * math.cos(math.radians(scale_lat))
    )
    scale_length = (
        SCALE_DISTANCE_MI
        * M_PER_MI
        / ground_m_per_world_unit
        * map_scale
    )
    parts.append(
        f'<line x1="{scale_x}" y1="{scale_y}" '
        f'x2="{scale_x + scale_length:.2f}" y2="{scale_y}" '
        f'stroke="{INK}" stroke-width="0.72"/>'
    )
    parts.append(
        f'<line x1="{scale_x}" y1="{scale_y - 2.1}" '
        f'x2="{scale_x}" y2="{scale_y + 2.1}" '
        f'stroke="{INK}" stroke-width="0.52"/>'
    )
    parts.append(
        f'<line x1="{scale_x + scale_length / 2.0:.2f}" '
        f'y1="{scale_y - 1.35}" '
        f'x2="{scale_x + scale_length / 2.0:.2f}" '
        f'y2="{scale_y + 1.35}" '
        f'stroke="{INK}" stroke-width="0.45"/>'
    )
    parts.append(
        f'<line x1="{scale_x + scale_length:.2f}" y1="{scale_y - 2.1}" '
        f'x2="{scale_x + scale_length:.2f}" y2="{scale_y + 2.1}" '
        f'stroke="{INK}" stroke-width="0.52"/>'
    )
    parts.append(
        f'<text x="{scale_x + scale_length / 2.0:.2f}" '
        f'y="{scale_y - 4.8}" class="utility" font-size="3.4" '
        f'text-anchor="middle">5 MILES</text>'
    )

    parts.append(
        f'<text x="{PROFILE_X}" y="427" class="utility" '
        f'font-size="3.8" fill="{MUTED}">ACTUAL ELEVATION</text>'
    )
    parts.append(
        f'<text x="{PROFILE_X + PROFILE_W}" y="427" '
        f'font-size="3.8" font-weight="300" fill="{MUTED}" '
        f'text-anchor="end">0 → 102.43 MILES</text>'
    )
    parts.append(
        f'<line x1="{PROFILE_X}" y1="436" '
        f'x2="{PROFILE_X + PROFILE_W}" y2="436" '
        f'stroke="{HAIR}" stroke-width="0.28"/>'
    )

    altitudes_ft = [sample[2] * FT_PER_M for sample in track]
    smoothed_altitudes = rolling_mean(altitudes_ft, 10)
    max_elevation = max(smoothed_altitudes)
    elevation_ceiling = math.ceil(max_elevation / 500.0) * 500.0
    baseline_y = PROFILE_Y + PROFILE_H

    profile_points = []
    profile_step = max(1, len(track) // 1300)
    for index in range(0, len(track), profile_step):
        display_mi = raw_distances[index] * distance_scale / M_PER_MI
        profile_points.append(
            (
                PROFILE_X + display_mi / total_mi * PROFILE_W,
                baseline_y
                - smoothed_altitudes[index] / elevation_ceiling * PROFILE_H,
            )
        )
    if profile_points[-1][0] < PROFILE_X + PROFILE_W:
        profile_points.append(
            (
                PROFILE_X + PROFILE_W,
                baseline_y
                - smoothed_altitudes[-1] / elevation_ceiling * PROFILE_H,
            )
        )
    profile_d = path_data(profile_points)
    area_points = (
        [(PROFILE_X, baseline_y)]
        + profile_points
        + [(PROFILE_X + PROFILE_W, baseline_y)]
    )
    parts.append(
        f'<path d="{path_data(area_points, close=True)}" '
        f'fill="{TERRAIN}" opacity="0.62"/>'
    )
    parts.append(
        f'<path d="{profile_d}" fill="none" stroke="{INK}" '
        f'stroke-width="0.9" stroke-linecap="round" '
        f'stroke-linejoin="round"/>'
    )
    parts.append(
        f'<line x1="{PROFILE_X}" y1="{baseline_y}" '
        f'x2="{PROFILE_X + PROFILE_W}" y2="{baseline_y}" '
        f'stroke="{INK}" stroke-width="0.35"/>'
    )

    for mile in [0, 25, 50, 75, total_mi]:
        x = PROFILE_X + mile / total_mi * PROFILE_W
        parts.append(
            f'<line x1="{x:.2f}" y1="{baseline_y}" '
            f'x2="{x:.2f}" y2="{baseline_y + 2.3}" '
            f'stroke="{INK}" stroke-width="0.32"/>'
        )
        label = f"{mile:.2f}" if mile == total_mi else f"{mile:.0f}"
        anchor = "end" if mile == total_mi else ("start" if mile == 0 else "middle")
        parts.append(
            f'<text x="{x:.2f}" y="{baseline_y + 7.5}" '
            f'font-size="3.3" fill="{MUTED}" text-anchor="{anchor}">'
            f'{label}</text>'
        )

    east_peak_mile = 77.9
    _, _, east_peak_alt_m = interpolate_track(
        track, raw_distances, east_peak_mile, distance_scale
    )
    east_peak_x = PROFILE_X + east_peak_mile / total_mi * PROFILE_W
    east_peak_y = (
        baseline_y - east_peak_alt_m * FT_PER_M / elevation_ceiling * PROFILE_H
    )
    parts.append(
        f'<circle cx="{east_peak_x:.2f}" cy="{east_peak_y:.2f}" '
        f'r="2.05" fill="{YELLOW}" stroke="{INK}" stroke-width="0.42"/>'
    )
    parts.append(
        f'<line x1="{east_peak_x:.2f}" y1="{east_peak_y - 2.1:.2f}" '
        f'x2="{east_peak_x:.2f}" y2="{east_peak_y - 11:.2f}" '
        f'stroke="{INK}" stroke-width="0.3"/>'
    )
    parts.append(
        f'<text x="{east_peak_x:.2f}" y="{east_peak_y - 13:.2f}" '
        f'class="utility" font-size="3.2" text-anchor="middle">'
        f'EAST PEAK</text>'
    )
    parts.append(
        f'<text x="{PROFILE_X}" y="{PROFILE_Y + 2}" '
        f'font-size="3.2" fill="{MUTED}">{elevation_ceiling:,.0f} FT</text>'
    )

    parts.append(
        f'<line x1="28" y1="548" x2="392" y2="548" '
        f'stroke="{INK}" stroke-width="0.35"/>'
    )
    parts.append(
        f'<text x="28" y="565" class="display" font-size="10.2">'
        f'HOME&#160;&#160;↻&#160;&#160;HEADLANDS</text>'
    )
    parts.append(
        f'<text x="392" y="561.5" class="utility" font-size="3.4" '
        f'text-anchor="end">HOMEDRED.PEDROLAB.ORG</text>'
    )
    parts.append(
        f'<text x="392" y="568.2" font-size="2.9" '
        f'font-weight="300" fill="{MUTED}" text-anchor="end">'
        f'ROUTE + ELEVATION FROM THE RECORDED ACTIVITY</text>'
    )
    parts.append(
        f'<text x="392" y="574.2" font-size="2.5" '
        f'font-weight="300" fill="{QUIET}" text-anchor="end">'
        f'BASE MAP © CARTO / OPENSTREETMAP CONTRIBUTORS</text>'
    )
    parts.append("</svg>")
    return "\n".join(parts)


def main() -> None:
    svg = build_svg()
    svg_path = POSTER_DIR / "homedred-miler-poster-a2.svg"
    html_path = POSTER_DIR / "homedred-miler-poster-a2.html"
    svg_path.write_text(svg)
    html_path.write_text(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Homedred Miler Poster</title>
  <style>
    @page {{ size: A2 portrait; margin: 0; }}
    html, body {{
      width: 420mm;
      height: 594mm;
      margin: 0;
      overflow: hidden;
      background: {PAPER};
    }}
    svg {{ display: block; width: 420mm; height: 594mm; }}
  </style>
</head>
<body>{svg}</body>
</html>
"""
    )
    print(svg_path)
    print(html_path)


if __name__ == "__main__":
    main()
