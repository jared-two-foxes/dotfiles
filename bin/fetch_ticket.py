#!/usr/bin/env python3
"""Fetch a Linear ticket by identifier, e.g. ./fetch_linear_ticket.py SA-456 [output.md]"""

import sys
import json
import urllib.request
import urllib.error
from pathlib import Path


def load_api_key() -> str:
    key_file = Path.home() / ".secrets" / "linear-key"
    return key_file.read_text().strip()


def fetch_ticket(identifier: str) -> dict:
    api_key = load_api_key()
    query = """
    query Issue($identifier: String!) {
      issue(id: $identifier) {
        id
        identifier
        title
        description
        priority
        state { name }
        assignee { name email }
        labels { nodes { name } }
        createdAt
        updatedAt
        url
      }
    }
    """
    payload = json.dumps({"query": query, "variables": {"identifier": identifier}}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": api_key,
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


PRIORITY_LABELS = {0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}


def render(data: dict) -> str:
    if "errors" in data:
        for e in data["errors"]:
            print(f"Error: {e['message']}", file=sys.stderr)
        sys.exit(1)

    issue = data.get("data", {}).get("issue")
    if not issue:
        print("Ticket not found.", file=sys.stderr)
        sys.exit(1)

    labels = ", ".join(n["name"] for n in issue["labels"]["nodes"]) or "—"
    assignee = issue["assignee"]["name"] if issue["assignee"] else "Unassigned"
    priority = PRIORITY_LABELS.get(issue["priority"], str(issue["priority"]))

    lines = [
        f"# {issue['identifier']} — {issue['title']}",
        "",
        f"| Field    | Value |",
        f"|----------|-------|",
        f"| State    | {issue['state']['name']} |",
        f"| Priority | {priority} |",
        f"| Assignee | {assignee} |",
        f"| Labels   | {labels} |",
        f"| Created  | {issue['createdAt'][:10]} |",
        f"| Updated  | {issue['updatedAt'][:10]} |",
        f"| URL      | {issue['url']} |",
    ]
    if issue["description"]:
        lines += ["", "## Description", "", issue["description"]]
    return "\n".join(lines) + "\n"


def main() -> None:
    if len(sys.argv) not in (2, 3):
        print(f"Usage: {sys.argv[0]} <ticket-id> [output-file]  (e.g. SA-456 .ticket.md)")
        sys.exit(1)
    identifier = sys.argv[1]
    output_path = Path(sys.argv[2]) if len(sys.argv) == 3 else Path(".ticket.md")
    try:
        data = fetch_ticket(identifier)
        content = render(data)
        output_path.write_text(content, encoding="utf-8")
        print(f"Written to {output_path}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
