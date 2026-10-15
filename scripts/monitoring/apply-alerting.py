#!/usr/bin/env python3
"""Apply the commonly-dev alerting config in k8s/monitoring/ to Cloud Monitoring.

    apply-alerting.py --check                        validate the JSON offline (CI runs this)
    apply-alerting.py --project P --email E [--dry-run]

Idempotent: notification channel, log-based metrics, uptime checks and alert
policies are matched by name / displayName and updated in place, never
duplicated. The config files carry no project identifier; the project and the
alert recipient are supplied at apply time. Runbook: docs/runbooks/alerting.md.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "k8s" / "monitoring"
RUNBOOK = ROOT / "docs" / "runbooks" / "alerting.md"
MONITORING = "https://monitoring.googleapis.com/v3"
LOGGING = "https://logging.googleapis.com/v2"
POLICY_PREFIX = "commonly-dev: "
UPTIME_REF = re.compile(r"\{\{uptime:([a-z0-9-]+)\}\}")
LOG_METRIC_REF = re.compile(r"logging\.googleapis\.com/user/([a-z0-9_]+)")
# Shapes that would put an infrastructure identifier into this public repo.
IDENTIFIER_SHAPES = re.compile(r"projects/|\.iam\.gserviceaccount\.com|\.svc\.id\.goog|@")


def load(name):
    return json.loads((CONFIG / name).read_text())


def runbook_anchors():
    anchors = set()
    for line in RUNBOOK.read_text().splitlines():
        if line.startswith("#"):
            title = line.lstrip("#").strip().lower()
            anchors.add(re.sub(r"[^a-z0-9 -]", "", title).replace(" ", "-"))
    return anchors


def check():
    uptime, metrics, policies = load("uptime-checks.json"), load("log-metrics.json"), load("alert-policies.json")
    errors = []
    uptime_keys = {u["key"] for u in uptime}
    metric_names = {m["name"] for m in metrics}
    anchors = runbook_anchors()

    for name in ("uptime-checks.json", "log-metrics.json", "alert-policies.json"):
        if IDENTIFIER_SHAPES.search((CONFIG / name).read_text()):
            errors.append(f"{name}: contains a project/account identifier shape")

    seen = set()
    for p in policies:
        title = p.get("displayName", "")
        if not title.startswith(POLICY_PREFIX):
            errors.append(f"{title!r}: displayName must start with {POLICY_PREFIX!r}")
        if title in seen:
            errors.append(f"{title!r}: duplicate displayName (apply matches on it)")
        seen.add(title)
        doc = p.get("documentation", {}).get("content", "")
        link = re.search(r"docs/runbooks/alerting\.md#([a-z0-9-]+)", doc)
        if not link or link.group(1) not in anchors:
            errors.append(f"{title!r}: documentation must link an existing docs/runbooks/alerting.md heading")
        if not p.get("conditions"):
            errors.append(f"{title!r}: no conditions")
        body = json.dumps(p)
        for ref in UPTIME_REF.findall(body):
            if ref not in uptime_keys:
                errors.append(f"{title!r}: references unknown uptime check {ref!r}")
        for ref in LOG_METRIC_REF.findall(body):
            if ref not in metric_names:
                errors.append(f"{title!r}: references undefined log metric {ref!r}")

    conditions = sum(len(p["conditions"]) for p in policies)
    for e in errors:
        print(f"FAIL {e}")
    print(f"{len(policies)} policies, {conditions} conditions, {len(uptime)} uptime checks, {len(metrics)} log metrics")
    return not errors


class Api:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.token = subprocess.run(
            ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True
        ).stdout.strip()

    def call(self, method, url, body=None):
        if self.dry_run and method != "GET":
            print(f"  [dry-run] {method} {url.split('?')[0]}")
            return body or {}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 404 and method == "GET":
                return None
            raise SystemExit(f"{method} {url.split('?')[0]} -> {e.code}: {e.read().decode()[:600]}")

    def list(self, url, field):
        items, token = [], ""
        while True:
            page = self.call("GET", url + (f"?pageToken={token}" if token else "")) or {}
            items += page.get(field, [])
            token = page.get("nextPageToken")
            if not token:
                return items


def apply(project, email, dry_run):
    api = Api(dry_run)
    base = f"{MONITORING}/projects/{project}"

    channels = api.list(f"{base}/notificationChannels", "notificationChannels")
    channel = next((c for c in channels if c.get("type") == "email"
                    and c.get("labels", {}).get("email_address") == email), None)
    if channel:
        print(f"channel: reuse {channel['displayName']}")
    else:
        channel = api.call("POST", f"{base}/notificationChannels", {
            "type": "email", "displayName": f"Alerts: {email}", "labels": {"email_address": email}})
        print(f"channel: created Alerts: {email}")
    channel_name = channel.get("name", "<dry-run channel>")

    for m in load("log-metrics.json"):
        url = f"{LOGGING}/projects/{project}/metrics/{m['name']}"
        if api.call("GET", url):
            api.call("PUT", url, m)
            print(f"log metric: updated {m['name']}")
        else:
            api.call("POST", f"{LOGGING}/projects/{project}/metrics", m)
            print(f"log metric: created {m['name']}")

    existing_checks = {u["displayName"]: u for u in api.list(f"{base}/uptimeCheckConfigs", "uptimeCheckConfigs")}
    check_ids = {}
    for u in load("uptime-checks.json"):
        key = u.pop("key")
        u["monitoredResource"]["labels"]["project_id"] = project
        current = existing_checks.get(u["displayName"])
        if current:
            mask = "displayName,httpCheck,contentMatchers,period,timeout,selectedRegions"
            result = api.call("PATCH", f"{MONITORING}/{current['name']}?updateMask={mask}", u)
            name = current["name"]
            print(f"uptime: updated {u['displayName']}")
        else:
            result = api.call("POST", f"{base}/uptimeCheckConfigs", u)
            name = result.get("name", f"<dry-run>/{key}")
            print(f"uptime: created {u['displayName']}")
        check_ids[key] = name.rsplit("/", 1)[-1]

    existing_policies = {p["displayName"]: p for p in api.list(f"{base}/alertPolicies", "alertPolicies")}
    for p in load("alert-policies.json"):
        body = json.loads(UPTIME_REF.sub(lambda m: check_ids[m.group(1)], json.dumps(p)))
        body.update({"enabled": True, "notificationChannels": [channel_name],
                     "alertStrategy": {"autoClose": "1800s"}})
        current = existing_policies.get(body["displayName"])
        if current:
            body["name"] = current["name"]
            api.call("PATCH", f"{MONITORING}/{current['name']}", body)
            print(f"policy: updated {body['displayName']}")
        else:
            api.call("POST", f"{base}/alertPolicies", body)
            print(f"policy: created {body['displayName']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="validate the config offline and exit")
    parser.add_argument("--project", help="GCP project that hosts the cluster's monitoring")
    parser.add_argument("--email", help="alert recipient")
    parser.add_argument("--dry-run", action="store_true", help="read live state, print writes without sending them")
    args = parser.parse_args()

    if not check():
        sys.exit(1)
    if args.check:
        return
    if not (args.project and args.email):
        parser.error("--project and --email are required unless --check")
    apply(args.project, args.email, args.dry_run)


if __name__ == "__main__":
    main()
