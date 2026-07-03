#!/usr/bin/env python3
"""Parse course.gpx -> app/src/data/course.json + POI snap report.

Computes cumulative distance, smoothed cumulative gain/loss prefix sums
(so the UI can compute stats for any segment instantly), and snaps a list
of known Marin/SF landmarks onto the track to find their mile markers.
"""
import json
import math
import os
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GPX = os.path.join(ROOT, "course.gpx")
OUT = os.path.join(ROOT, "app", "src", "data", "course.json")

NS = {"g": "http://www.topografix.com/GPX/1/1"}

M_TO_FT = 3.28084
M_TO_MI = 1 / 1609.344


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def smooth(vals, w=5):
    half = w // 2
    out = []
    for i in range(len(vals)):
        lo, hi = max(0, i - half), min(len(vals), i + half + 1)
        out.append(sum(vals[lo:hi]) / (hi - lo))
    return out


def main():
    tree = ET.parse(GPX)
    pts = []
    for tp in tree.getroot().iter("{http://www.topografix.com/GPX/1/1}trkpt"):
        lat = float(tp.get("lat"))
        lon = float(tp.get("lon"))
        ele = float(tp.find("g:ele", NS).text)
        pts.append((lat, lon, ele))

    n = len(pts)
    dist = [0.0] * n  # meters
    for i in range(1, n):
        dist[i] = dist[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])

    ele_s = smooth([p[2] for p in pts], w=7)

    # Hysteresis-threshold gain/loss accumulation (2 m) to suppress noise.
    THRESH = 2.0
    gain = [0.0] * n
    loss = [0.0] * n
    anchor = ele_s[0]
    g = l = 0.0
    for i in range(1, n):
        d = ele_s[i] - anchor
        if d >= THRESH:
            g += d
            anchor = ele_s[i]
        elif d <= -THRESH:
            l += -d
            anchor = ele_s[i]
        gain[i] = g
        loss[i] = l

    total_mi = dist[-1] * M_TO_MI
    print(f"points={n}  total={total_mi:.2f} mi  gain={g * M_TO_FT:,.0f} ft  loss={l * M_TO_FT:,.0f} ft")
    max_i = max(range(n), key=lambda i: pts[i][2])
    print(f"max ele {pts[max_i][2] * M_TO_FT:,.0f} ft at mile {dist[max_i] * M_TO_MI:.2f}  ({pts[max_i][0]:.5f},{pts[max_i][1]:.5f})")
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    print(f"bbox lat [{min(lats):.4f},{max(lats):.4f}] lon [{min(lons):.4f},{max(lons):.4f}]")
    print(f"start ({pts[0][0]:.5f},{pts[0][1]:.5f})  end ({pts[-1][0]:.5f},{pts[-1][1]:.5f})")
    for m in range(10, int(total_mi) + 1, 10):
        i = min(range(n), key=lambda i: abs(dist[i] * M_TO_MI - m))
        print(f"  mile {m}: ({pts[i][0]:.5f},{pts[i][1]:.5f}) ele {pts[i][2]*M_TO_FT:,.0f} ft")

    # ---- POI snapping ------------------------------------------------
    POIS = [
        ("start (Golden Gate Park)", 37.76621, -122.46424),
        ("Ocean Beach", 37.7599, -122.5108),
        ("Lands End / Cliff House", 37.7780, -122.5119),
        ("Crissy Field / GGB south", 37.8060, -122.4745),
        ("GGB north / Vista Point", 37.8323, -122.4813),
        ("Fort Baker", 37.8355, -122.4772),
        ("Hawk Hill / Conzelman", 37.8253, -122.4996),
        ("Rodeo Beach lot", 37.8322, -122.5366),
        ("Headlands Visitor Ctr", 37.8352, -122.5227),
        ("Tennessee Valley TH", 37.8604, -122.5364),
        ("Muir Beach lot", 37.8627, -122.5744),
        ("Muir Beach Overlook", 37.8626, -122.5860),
        ("Muir Woods", 37.8912, -122.5711),
        ("Mountain Home Inn", 37.9098, -122.5772),
        ("Bootjack", 37.9092, -122.6034),
        ("Pantoll", 37.9040, -122.6045),
        ("Rock Spring", 37.9074, -122.6125),
        ("Cardiac (Dipsea/Coastal)", 37.8990, -122.6120),
        ("Stinson Beach NPS lot", 37.8987, -122.6425),
        ("Old Mill Park Mill Valley", 37.9052, -122.5484),
        ("Sausalito ferry", 37.8590, -122.4785),
        ("Tam Junction", 37.8737, -122.5064),
        ("Four Corners (Panoramic/Muir Woods Rd)", 37.8998, -122.5680),
        ("East Peak lot", 37.9296, -122.5800),
        # northern loop probes
        ("Bolinas-Fairfax Rd @ Ridgecrest", 37.9354, -122.6270),
        ("Alpine Dam", 37.9420, -122.6440),
        ("Five Brooks TH", 37.9932, -122.7573),
        ("Olema", 38.0405, -122.7404),
        ("Bolinas Ridge TH (Sir Francis Drake)", 38.0290, -122.7288),
        ("Samuel P Taylor SP entrance", 38.0187, -122.7304),
        ("Shafter Bridge / Inkwells", 38.0090, -122.6960),
        ("Kent Lake dam area", 37.9950, -122.6660),
        ("San Geronimo", 38.0130, -122.6540),
        ("Lagunitas town", 38.0110, -122.6910),
        ("Peters Dam Rd gate", 38.0025, -122.6862),
        ("Azalea Hill / Bol-Fx pullout", 37.9560, -122.6180),
        ("Pine Mountain TH", 37.9530, -122.6100),
        ("Rock Spring lot", 37.9110, -122.6120),
        ("Ridgecrest @ Rock Spring", 37.9105, -122.6115),
        ("Mill Valley downtown", 37.9060, -122.5450),
        ("Deer Park fire rd / Dipsea steps", 37.8990, -122.5590),
        ("Coyote Ridge", 37.8710, -122.5530),
        ("Dias Ridge mid", 37.8760, -122.5680),
        ("Bootjack lot", 37.9075, -122.6040),
        ("West Point Inn", 37.9130, -122.5920),
        ("Old Railroad Grade mid", 37.9180, -122.5850),
        ("Blithedale Ridge", 37.9210, -122.5600),
        ("Corte Madera Ridge", 37.9330, -122.5680),
        ("Randall TH (Hwy 1)", 37.9410, -122.6890),
        ("Bolinas Ridge mid", 37.9700, -122.7100),
        ("McCurdy TH", 37.9520, -122.6930),
        ("Sky Oaks / Bon Tempe", 37.9640, -122.6100),
        ("Fairfax", 37.9870, -122.5890),
        # refined probes
        ("West Point Inn (exact)", 37.91194, -122.59625),
        ("Alpine Dam (exact)", 37.94105, -122.63215),
        ("Laurel Dell", 37.92030, -122.62810),
        ("Bon Tempe Dam", 37.95050, -122.61350),
        ("Cataract TH @ Bol-Fx hairpin", 37.92830, -122.63640),
        ("BoFax @ Ridgecrest gate", 37.93460, -122.64520),
        ("Willow Camp FR base", 37.90310, -122.63930),
        ("Pelican Inn", 37.86230, -122.57370),
        ("Redwood Creek TH (Muir Woods Rd)", 37.88600, -122.57150),
        ("Bobcat/Marincello junction", 37.85584, -122.51340),
        ("GGB Welcome Center south", 37.80770, -122.47500),
        ("Old Inn / Panoramic @ Ocean View", 37.90600, -122.57200),
        ("Tocaloma / Platform Bridge (SFD)", 38.03700, -122.75500),
        ("Jewell TH Cross Marin", 38.03400, -122.74000),
        ("Irving Picnic SPT", 38.02400, -122.73600),
        ("Devils Gulch SPT", 38.03100, -122.72400),
    ]
    print("\nPOI snaps (all passes within 400 m):")
    for name, plat, plon in POIS:
        best = min(range(n), key=lambda i: haversine(plat, plon, pts[i][0], pts[i][1]))
        d = haversine(plat, plon, pts[best][0], pts[best][1])
        if d > 400:
            print(f"  [off-course {d:>6,.0f} m] {name}")
            continue
        # A point can be passed multiple times (out & back / loops):
        # report every local pass within 400 m.
        passes = []
        i = 0
        while i < n:
            dd = haversine(plat, plon, pts[i][0], pts[i][1])
            if dd < 400:
                j = i
                bi, bd = i, dd
                while j < n and haversine(plat, plon, pts[j][0], pts[j][1]) < 400:
                    dj = haversine(plat, plon, pts[j][0], pts[j][1])
                    if dj < bd:
                        bi, bd = j, dj
                    j += 1
                passes.append((bi, bd))
                i = j + 40
            else:
                i += 1
        miles = ", ".join(f"mi {dist[i] * M_TO_MI:6.2f} ({dd:.0f}m)" for i, dd in passes)
        print(f"  {name:<38} {miles}")

    # ---- output ------------------------------------------------------
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = {
        "name": "Homedred Miler",
        "totalMi": round(total_mi, 2),
        "gainFt": round(g * M_TO_FT),
        "lossFt": round(l * M_TO_FT),
        "minEleFt": round(min(p[2] for p in pts) * M_TO_FT),
        "maxEleFt": round(max(p[2] for p in pts) * M_TO_FT),
        # [lat, lon, eleFt, distMi, cumGainFt, cumLossFt] per point
        "pts": [
            [
                round(p[0], 5),
                round(p[1], 5),
                round(p[2] * M_TO_FT, 1),
                round(dist[i] * M_TO_MI, 4),
                round(gain[i] * M_TO_FT, 1),
                round(loss[i] * M_TO_FT, 1),
            ]
            for i, p in enumerate(pts)
        ],
    }
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"\nwrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
