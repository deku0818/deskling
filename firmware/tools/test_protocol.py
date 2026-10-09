"""Run the device snapshot parser on the host with ESP-IDF's own cJSON."""
import os
from pathlib import Path
import subprocess
import tempfile

firmware = Path(__file__).resolve().parents[1]
idf_path = os.environ.get("IDF_PATH")
if not idf_path:
    raise SystemExit("Activate ESP-IDF first, or set IDF_PATH to its installation directory.")
cjson = Path(idf_path) / "components/json/cJSON"
with tempfile.TemporaryDirectory(prefix="deskling-protocol-") as directory:
    binary = str(Path(directory) / "test-protocol")
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations",
        "-I", str(firmware / "main"), "-I", str(cjson),
        str(firmware / "main/protocol.c"), str(firmware / "tools/test_protocol.c"),
        str(cjson / "cJSON.c"), "-o", binary,
    ], check=True)
    subprocess.run([binary], check=True)
