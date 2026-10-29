Aurora - YouTube Downloader (Windows portable)
==============================================

WHAT IS IN THIS ZIP
  Aurora.exe    the whole app: Python + yt-dlp + ffmpeg + the interface
  Aurora.bat    double-click this to start it
  README.txt    this file

HOW TO RUN
  1. Unzip this folder anywhere you like (keep Aurora.bat next to Aurora.exe).
  2. Double-click Aurora.bat.
  3. Your browser opens http://127.0.0.1:8765 by itself once it is ready.
  4. Paste a YouTube link (video, Short, playlist - several links at once),
     pick MP3 or MP4, choose a folder, press Download.

  Nothing to install: no Python, no Node, no ffmpeg.

STOPPING IT
  Close the Aurora window.

NOTES
  - Everything runs on your own PC. Files are written straight to the folder
    you pick; nothing is uploaded anywhere.
  - Default save folder: C:\Users\<you>\Downloads   (change it with "Change")
  - If Windows Defender flags the exe, it is a false positive: Aurora.exe is a
    self-contained Python build made with PyInstaller and is not code-signed.
  - Port 8765 must be free. If something else uses it, run:
        Aurora.exe --port 9000
    and open http://127.0.0.1:9000 instead.

made by arafanh arx cobra
