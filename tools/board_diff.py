"""Compare two board payloads, ignoring only what is allowed to differ.

Usage: python tools/board_diff.py OLD.json NEW.json
Exit 0 if every pre-existing key matches; 1 with a report if not.

Per-key on purpose: the new `league` block is inserted mid-payload, so a raw
text diff shows a change where none of the published values moved.
"""
import json
import sys

IGNORE = {"generated_at", "league"}   # volatile, and the new additive block


def main(old_path, new_path):
    old = json.load(open(old_path, encoding="utf-8"))
    new = json.load(open(new_path, encoding="utf-8"))
    problems = []
    for key in sorted(set(old) | set(new)):
        if key in IGNORE:
            continue
        if key not in new:
            problems.append(f"key dropped: {key}")
        elif key not in old:
            problems.append(f"key added: {key}")
        elif old[key] != new[key]:
            if key == "players":
                a, b = old[key], new[key]
                problems.append(f"players: {len(a)} vs {len(b)} rows")
                diff = [(x.get("name"), sorted(
                            k for k in set(x) | set(y) if x.get(k) != y.get(k)))
                        for x, y in zip(a, b) if x != y]
                problems.append(f"  {len(diff)} rows differ; first 5: {diff[:5]}")
            else:
                problems.append(f"{key}:\n  old {old[key]}\n  new {new[key]}")
    if problems:
        print("\n".join(problems))
        return 1
    print("identical on every pre-existing key")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
