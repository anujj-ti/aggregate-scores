"""Generate worker Pydantic contracts from shared JSON Schema artifacts."""

from pathlib import Path
import json
import subprocess


def _definition_payload(schema: dict) -> tuple[str, dict]:
    """Extract the referenced top-level definition from zod-to-json-schema output."""
    definitions = schema.get("definitions")
    if not isinstance(definitions, dict) or not definitions:
        raise ValueError("schema file does not contain definitions")

    ref = schema.get("$ref")
    if not isinstance(ref, str):
        raise ValueError("schema file does not contain $ref")
    prefix = "#/definitions/"
    if not ref.startswith(prefix):
        raise ValueError(f"unsupported schema $ref format: {ref}")
    name = ref.removeprefix(prefix)
    if name not in definitions:
        raise ValueError(f"schema $ref target not found in definitions: {name}")

    payload = definitions[name]
    if not isinstance(payload, dict):
        raise ValueError("definition payload is not an object")
    return name, payload


def main() -> None:
    """Generate pydantic_v2 models from packages/shared/schemas into worker/contracts.py."""
    repo_root = Path(__file__).resolve().parents[1]
    schema_dir = repo_root / "packages" / "shared" / "schemas"
    out_file = repo_root / "apps" / "worker" / "src" / "worker" / "contracts.py"
    temp_bundle = repo_root / ".tmp" / "shared-contracts-bundle.schema.json"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    temp_bundle.parent.mkdir(parents=True, exist_ok=True)

    defs: dict[str, dict] = {}
    for schema_file in sorted(schema_dir.glob("*.schema.json")):
        parsed = json.loads(schema_file.read_text(encoding="utf8"))
        name, payload = _definition_payload(parsed)
        defs[name] = payload

    bundle = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "SharedContractsBundle",
        "type": "object",
        "anyOf": [{"$ref": f"#/$defs/{name}"} for name in defs],
        "$defs": defs
    }
    temp_bundle.write_text(f"{json.dumps(bundle, indent=2)}\n", encoding="utf8")

    cmd = [
        "datamodel-codegen",
        "--input",
        str(temp_bundle),
        "--input-file-type",
        "jsonschema",
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--output",
        str(out_file),
        "--disable-timestamp",
        "--target-python-version",
        "3.11",
        "--field-constraints",
        "--use-standard-collections"
    ]
    subprocess.run(cmd, check=True)
    subprocess.run(["black", str(out_file)], check=True)


if __name__ == "__main__":
    main()
