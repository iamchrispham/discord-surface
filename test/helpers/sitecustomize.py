import os

marker = os.environ.get("FIXTURE_PYTHON_SITE_MARKER")
if marker:
    with open(marker, "w", encoding="utf-8") as handle:
        handle.write("sitecustomize ran")
