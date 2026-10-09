"""Exercise the production provisioning configuration parser on the host."""
import os
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
idf = Path(os.environ['IDF_PATH'])
cjson = idf / 'components/json/cJSON'
http = idf / 'components/http_parser'
with tempfile.TemporaryDirectory(prefix='deskling-provision-test-') as directory:
    binary = str(Path(directory) / 'test-provision')
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I',str(root/'main'),'-I',str(cjson),'-I',str(http),str(root/'main/provision_config.c'),str(root/'tools/test_provision_config.c'),str(cjson/'cJSON.c'),str(http/'http_parser.c'),'-o',binary],check=True)
    subprocess.run([binary],check=True)
