# MediaCast DLNA Stack (JavaScript)

A minimal UPnP/DLNA casting stack in JavaScript with **real-time FFmpeg transcoding** for:

- Discovering MediaRenderer devices over UPnP (SSDP)
- Hosting local media over HTTP with byte-range support
- **Auto-detect and real-time FFmpeg transcoding** to H.264 + AAC/MP4 (DLNA-safe)
- Casting media via AVTransport SOAP (`SetAVTransportURI` + `Play`)
- Basic playback controls (`pause`, `stop`, `volume`)

## What this supports

- Containers: MP4, MKV, AVI, MOV, M4V, TS
- Audio files: MP3, AAC, M4A, WAV, FLAC
- Video codecs: H.264, H.265/HEVC, x265 profiles
- Audio codecs in container (like AC3): any FFmpeg-compatible format

**Files that don't match H.264 + AAC/MP4 will be automatically transcoded in real-time.**

## Requirements

- Node.js 18+
- **FFmpeg & FFprobe** installed (`ffmpeg` and `ffprobe` available on PATH)
  - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html) or `choco install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `apt-get install ffmpeg` (Debian/Ubuntu)
- Local network where controller and renderer can reach each other

## Install

```bash
npm install
```

## Commands

### Discover renderers

```bash
npm run discover
npm run discover -- --timeout 7000
```

### Show format notes

```bash
npm run formats
```

### Probe a media file for codec/transcoding info

```bash
node src/cli.js info --file "F:/Media/movie.mkv"
```

Outputs: container, streams, codec names, and whether transcoding is required.

### Serve a media directory

```bash
node src/cli.js serve --dir "F:/Media"
node src/cli.js serve --dir "F:/Media" --force-transcode
node src/cli.js serve --dir "F:/Media" --no-transcode
```

Options:
- `--no-transcode`: Disable FFmpeg; direct play only
- `--force-transcode`: Transcode all files (for testing)
- `--video-preset <preset>`: FFmpeg speed (ultrafast, fast, medium, slow)
- `--audio-bitrate <bitrate>`: Audio quality (e.g., 128k, 192k)

### Cast one local file

```bash
node src/cli.js cast-file --file "F:/Media/movie.mkv" --renderer "Living Room TV"
```

Options: `--no-transcode`, `--force-transcode`, `--video-preset`, `--audio-bitrate`

Auto-detection: File is probed; if it needs transcoding, FFmpeg starts streaming H.264+AAC/MP4 transparently.

### Cast an existing URL

```bash
node src/cli.js cast-url --url "http://192.168.1.100:8080/media/1" --renderer "Living Room TV"
```

### Playback controls

```bash
node src/cli.js pause --renderer "Living Room TV"
node src/cli.js stop --renderer "Living Room TV"
node src/cli.js volume --value 35 --renderer "Living Room TV"
```

## Transcoding Details

### Detection

Files are checked using `ffprobe` to see if they match:
- Container: MP4
- Video codec: H.264
- Audio codec: AAC

If the file doesn't match, FFmpeg transcodes in real-time while streaming.

### Performance

- **H.264 only**: Medium preset (balance quality/speed)
  - CRF 23 (reasonable quality, ~2-4 Mbps for 1080p)
  - `-preset medium` (~30 fps on modest CPU)
- **Tune to your hardware**: 
  - Weak devices: `--video-preset ultrafast` (faster but lower quality)
  - Powerful PCs: `--video-preset slow` (better quality)

### CPU Impact

- Direct play: Minimal
- Transcode (1080p H.265 → H.264): 30–100% single core CPU (depends on preset + hardware)
- Consider hardware encoding if available (future extension)

## Examples

### Simple media library with auto-transcoding

```bash
node src/cli.js serve --dir "D:\Movies"
# Clients can now play direct-play MP4s or transcoded HEVC/MKV on any DLNA TV.
```

### Cast difficult HEVC file

```bash
node src/cli.js cast-file --file "D:\4K\hevc_movie.mkv" \
  --renderer "Living Room" \
  --video-preset fast
# Auto-detects HEVC codec, spawns FFmpeg, streams H.264+AAC to TV.
```

### Force transcode for testing

```bash
node src/cli.js cast-file --file "D:\simple.mp4" \
  --force-transcode
# Even though MP4/H.264/AAC already, forces re-encode to test transcoding flow.
```

### Check if a file needs transcoding

```bash
node src/cli.js info --file "D:\video.mkv"
```

## Notes on compatibility

- If FFmpeg is not available, the `info` command and auto-transcode detection will fail gracefully.
- Renderers have equipment limits; extremely high-bitrate H.264 streams may stall.
- Subtitle handling: Burned in during transcode if present in file (future refinement).
- Audio passthrough (AC3, DTS) post-transcode: Currently normalizes to AAC (can be tuned).

## Architecture

```
┌─ CLICommandRouter
│   └─ parse args
├─ MediaServer (HTTP + DLNA metadata)
│   ├─ Library indexing
│   ├─ Detection (ffprobe)
│   └─ _handleMediaRequest
│       ├─ Direct stream (byte-range)
│       └─ FFmpegTranscoder (spawn, pipe output)
├─ UPnP Discovery (SSDP client)
│   └─ SOAP AVTransport / RenderingControl
└─ DLNA Metadata (DIDL-Lite XML)
```

## Future extensions

- Hardware transcoding (NVIDIA NVENC, Intel QSV, macOS VideoToolbox)
- Subtitle embedding options
- Adaptive bitrate adjustment for network conditions
- Transcode progress/UI feedback
- Cache transcoded segments for re-requests
