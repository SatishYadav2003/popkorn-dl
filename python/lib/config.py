"""Settings and paths shared by every module. Numbers come from shared/settings.json;
values from .env arrive through the environment, loaded by run.sh."""
import os
from pathlib import Path

from .shared import settings

SEARCH_TIMEOUT = settings["searchTimeout"]  # seconds to wait for the result list / a page turn
FILE_TIMEOUT = settings["fileTimeout"]      # seconds to wait for the file after /start
CHUNK = settings["chunk"]                   # Telegram's max request size
WORKERS = settings["workers"]               # parallel requests
STREAM_PORT = settings["streamPort"]        # falls back to any free port if taken

# Telethon adds ".session" to this.
SESSION_FILE = Path(__file__).resolve().parent.parent / "popkorn"

download_dir = Path(os.environ.get("DOWNLOAD_DIR") or "downloads")
# Half-done downloads and their resume records live here, out of sight. It sits
# inside download_dir so the finished file can simply be renamed into place.
incomplete_dir = download_dir / ".incomplete"
