import json

from internal.agent import symbols


def test_parse_ctags_json_relative_path(tmp_path) -> None:
    path = tmp_path / "main.c"
    path.write_text("int main() { return 0; }\n", encoding="utf-8")
    raw = json.dumps(
        {
            "_type": "tag",
            "name": "main",
            "path": str(path),
            "kind": "function",
            "line": 1,
            "language": "C",
        }
    )
    entry = symbols._parse_ctags_json(raw, tmp_path)
    assert entry is not None
    assert entry.file == "main.c"
    assert entry.name == "main"
    assert entry.kind == "function"
    assert entry.language == "C"


def test_repo_map_uses_cached_index(tmp_path) -> None:
    workspace = tmp_path
    (workspace / "app.py").write_text("def foo():\n  pass\n", encoding="utf-8")
    files = ["app.py"]

    index_path, meta_path = symbols._index_paths(workspace)
    entries = [
        symbols.SymbolEntry(
            file="app.py",
            line=1,
            name="foo",
            kind="function",
            language="Python",
        )
    ]
    symbols._write_index_entries(index_path, entries)
    fingerprint = symbols._compute_fingerprint(workspace, files)
    symbols._write_meta(meta_path, fingerprint, "ctags")

    output = symbols.build_repo_map(str(workspace), files, 10)
    assert "app.py" in output
    assert "foo" in output
