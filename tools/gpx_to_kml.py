#!/usr/bin/env python3
"""Convert a GPX track to a Google Earth-compatible KML path."""

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path


GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}
KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)


def kml_tag(name):
    return f"{{{KML_NS}}}{name}"


def add_text(parent, name, value):
    element = ET.SubElement(parent, kml_tag(name))
    element.text = str(value)
    return element


def convert(source, destination):
    gpx = ET.parse(source).getroot()
    metadata_name = gpx.findtext("g:metadata/g:name", namespaces=GPX_NS)
    track = gpx.find("g:trk", GPX_NS)
    if track is None:
        raise ValueError(f"No GPX track found in {source}")

    track_name = track.findtext("g:name", default=metadata_name or source.stem, namespaces=GPX_NS)
    segments = track.findall("g:trkseg", GPX_NS)
    if not segments:
        raise ValueError(f"No GPX track segments found in {source}")

    root = ET.Element(kml_tag("kml"))
    document = ET.SubElement(root, kml_tag("Document"))
    add_text(document, "name", track_name)
    add_text(document, "description", f"Converted from {source.name}")

    style = ET.SubElement(document, kml_tag("Style"), {"id": "course"})
    line_style = ET.SubElement(style, kml_tag("LineStyle"))
    add_text(line_style, "color", "ff7cf1f1")  # #f1f17c in KML AABBGGRR
    add_text(line_style, "width", "4")

    point_count = 0
    for index, segment in enumerate(segments, start=1):
        points = segment.findall("g:trkpt", GPX_NS)
        if not points:
            continue

        placemark = ET.SubElement(document, kml_tag("Placemark"))
        suffix = f" — segment {index}" if len(segments) > 1 else ""
        add_text(placemark, "name", f"{track_name}{suffix}")
        add_text(placemark, "styleUrl", "#course")

        line = ET.SubElement(placemark, kml_tag("LineString"))
        add_text(line, "tessellate", "1")
        add_text(line, "altitudeMode", "absolute")

        coordinates = []
        for point in points:
            lat = point.get("lat")
            lon = point.get("lon")
            elevation = point.findtext("g:ele", default="0", namespaces=GPX_NS)
            coordinates.append(f"{lon},{lat},{elevation}")
        add_text(line, "coordinates", "\n" + "\n".join(coordinates) + "\n")
        point_count += len(points)

    ET.indent(root, space="  ")
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)
    return track_name, point_count, len(segments)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    destination = args.destination or args.source.with_suffix(".kml")

    name, points, segments = convert(args.source, destination)
    print(f"Wrote {destination}: {name}, {points:,} points, {segments} segment(s)")


if __name__ == "__main__":
    main()
