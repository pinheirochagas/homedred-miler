---
name: import-route-media
description: Inventories a user-provided media folder, recovers capture times and GPS, maps every photo, video, and audio item to the Homedred Miler route, creates web assets, and updates the app media catalog. Use when the user provides a folder of race media or asks to map, assign, geolocate, or import media.
---

# Import Route Media

Use this workflow after the user provides a source folder. Treat the source folder as read-only.

## Required inputs

- Source media folder.
- Activity FIT/GPX/TCX files, if available.
- Any user-provided clock offset, timezone, placement, or “ignore time” instruction.

Ask only when unresolved timing or placement would materially change the result.

## Stage 1: inventory and map everything

1. Recursively inventory photos, RAW files, videos, audio, activity tracks, and sidecars. Ignore hidden/temp files.
2. Hash source files to detect exact duplicates. Never rename, convert, or write into the source folder.
3. Extract metadata before conversion:
   - Photos/RAW: `DateTimeOriginal`, offset/timezone, GPS, orientation, camera, dimensions.
   - Video/audio: creation time, duration, rotation, dimensions, codecs, and QuickTime ISO 6709 location.
   - Prefer embedded capture metadata over filesystem modification dates.
4. Create or update `app/src/media-manifest.json`. Store source paths relative to the supplied root, never absolute personal paths.
5. Give each item a stable unique slug ID and classify it as `photo`, `video`, `audio`, `duplicate`, `unsupported`, or `needs-review`.

Each manifest record should retain:

```json
{
  "id": "stable-slug",
  "sourcePath": "relative/path/IMG_0001.JPG",
  "sourceHash": "sha256",
  "type": "photo",
  "capturedAt": "ISO-8601 instant or null",
  "timestampSource": "exif|quicktime|activity-match|manual|unknown",
  "lat": null,
  "lon": null,
  "locationSource": "embedded-gps|activity-match|manual|unknown",
  "locationConfidence": "high|medium|low|unresolved",
  "routeMi": null,
  "routeOffsetM": null,
  "title": "Human-readable title",
  "alt": "Accurate description",
  "status": "resolved|needs-review|duplicate|unsupported",
  "notes": ""
}
```

## Recover missing locations

Use this priority order:

1. Embedded GPS.
2. Timestamp interpolation against an activity FIT/GPX/TCX track.
3. A user-specified location or route mile.
4. Leave unresolved; do not silently guess.

For timezone-less camera timestamps:

- Normalize activity timestamps to UTC.
- Infer a camera offset only from user guidance or at least two reliable GPS/time anchors.
- Use a robust median offset and check residual error. If anchors disagree, mark the batch for review.
- Nikon/RAW timestamps commonly lack timezone/GPS; never assume the apparent timezone is correct.

Interpolate between adjacent activity points only when the time gap is reasonable. Record the method and confidence.

## Associate media with the course

- Use `course_v4.gpx` / `app/src/data/course.json`.
- Preserve the actual media coordinates for the map marker.
- Compute nearest route candidates, route mile, and perpendicular offset.
- Use capture sequence or activity time to disambiguate repeated/overlapping route sections such as outbound and return crossings.
- Flag large route offsets and timestamps outside the activity interval.
- If an explicit `routeMi` is needed, update `routeMedia` in `app/src/main.js` to honor it instead of using nearest-point snapping alone.

Before asset generation, summarize counts for direct GPS, activity-matched, manually assigned, duplicates, unsupported, and unresolved items.

## Stage 2: create app assets

Write generated files only under `app/src/assets/media/`. Use deterministic filenames based on the manifest ID.

- **Photos/RAW:** apply orientation, convert unsupported formats to web JPEG, create a lightweight thumbnail and an optimized display image, and preserve aspect ratio.
- **Video:** create H.264/AAC MP4 with `yuv420p` and fast-start, preserve orientation/aspect ratio, and extract a representative JPEG poster.
- **Audio:** retain or create a browser-compatible audio file and generate the existing iPhone-style bar waveform SVG.
  - Bars must divide the complete audio duration into equal time bins.
  - Smoothing may change amplitude only; it must not shift, crop, pad, or letterbox the timeline.
  - SVGs used in the wide player must include `preserveAspectRatio="none"` so bars and playhead share exactly the same width.

Do not upscale small media or discard originals.

## Titles and descriptions

- Derive a readable title from trustworthy metadata, route context, or filename.
- Inspect a thumbnail before writing visual alt text.
- Do not invent people, places, events, dates, or transcript content.
- Use neutral filename-derived titles when context is unknown and mark them for review.

## App integration

- Preserve the `mediaItems` contract in `app/src/media.js`: `id`, `type`, `src`, `thumbnailSrc`, optional `mimeType`, `title`, `alt`, optional `capturedAt`, `lat`, `lon`, `width`, and `height`.
- For a large batch, generate the imports/catalog deterministically rather than hand-maintaining dozens of imports.
- Do not regress one-click map opening, elevation-profile selection, popup resizing, or photo/video/audio behavior.

## Verification

1. Validate every resolved item has an existing output asset, unique ID, valid coordinates, dimensions, and route assignment.
2. Spot-check route placement and chronological ordering, especially repeated course sections.
3. For audio, verify at 0%, 25%, 50%, 75%, and 100% that playhead progress matches `currentTime / duration`.
4. Run the production build and check lints.
5. Test representative photo, video, and audio items on the map and elevation profile.
6. Report imported, duplicate, unresolved, and failed counts plus every assumption.

Do not commit or push unless the user explicitly asks.
