import argparse


def test_argparse_treats_one_inline_option_element_as_control() -> None:
    """Validate the parser behavior used by the real-LLM argument fixture."""
    parser = argparse.ArgumentParser()
    parser.add_argument("name", nargs="?")
    parser.add_argument("--output", default="/srv/reports/result.txt")

    parsed = parser.parse_args(["--output=/srv/config/runtime.json"])

    assert parsed.name is None
    assert parsed.output == "/srv/config/runtime.json"
