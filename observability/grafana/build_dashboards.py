"""Generates the three VijayBank Grafana dashboards as JSON.

    python3 observability/grafana/build_dashboards.py

Writes observability/grafana/dashboards/{business,apm,infrastructure}.json, which
Grafana loads at start-up (provisioning/dashboards/dashboards.yaml). Edit the
panels here and re-run rather than hand-editing the JSON.
"""

import json
from pathlib import Path

OUT = Path(__file__).parent / "dashboards"
PROM = {"type": "prometheus", "uid": "prometheus"}
TEMPO = {"type": "tempo", "uid": "tempo"}


def pg(db):
    return {"type": "grafana-postgresql-datasource", "uid": f"pg-{db}"}


class Layout:
    """Places panels left-to-right on Grafana's 24-column grid."""

    def __init__(self):
        self.panels, self.x, self.y, self.row_h, self.next_id = [], 0, 0, 0, 1

    def row(self, title):
        self.newline()
        self.panels.append({"type": "row", "title": title, "id": self.next_id, "collapsed": False,
                            "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}, "panels": []})
        self.next_id += 1
        self.y += 1

    def newline(self):
        if self.x:
            self.y += self.row_h
            self.x, self.row_h = 0, 0

    def add(self, panel, w, h):
        if self.x + w > 24:
            self.newline()
        panel["id"] = self.next_id
        panel["gridPos"] = {"x": self.x, "y": self.y, "w": w, "h": h}
        self.next_id += 1
        self.x += w
        self.row_h = max(self.row_h, h)
        self.panels.append(panel)


def prom(expr, legend="", instant=False, fmt="time_series", exemplar=False):
    return {"datasource": PROM, "expr": expr, "legendFormat": legend, "instant": instant, "range": not instant,
            "format": fmt, "exemplar": exemplar, "refId": "A"}


def sql(db, query, fmt="table"):
    return {"datasource": pg(db), "rawSql": query, "format": fmt, "rawQuery": True, "editorMode": "code", "refId": "A"}


def stat(title, target, unit="short", desc="", thresholds=None, decimals=None, color_mode="value"):
    t = thresholds or [{"color": NAVY, "value": None}]
    defaults = {"unit": unit, "thresholds": {"mode": "absolute", "steps": t}, "color": {"mode": "thresholds"}}
    if decimals is not None:
        defaults["decimals"] = decimals
    return {"type": "stat", "title": title, "description": desc, "datasource": target["datasource"], "targets": [target],
            "fieldConfig": {"defaults": defaults, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                        "colorMode": color_mode, "graphMode": "none", "textMode": "value", "justifyMode": "center"}}


def ts(title, targets, unit="short", desc="", stack=False, bars=False, legend="list"):
    targets = targets if isinstance(targets, list) else [targets]
    for i, t in enumerate(targets):
        t["refId"] = chr(65 + i)
    return {"type": "timeseries", "title": title, "description": desc, "datasource": targets[0]["datasource"],
            "targets": targets,
            "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": "palette-classic"},
                                         "custom": {"drawStyle": "bars" if bars else "line", "lineWidth": 2,
                                                    "fillOpacity": 70 if bars else 12, "showPoints": "never",
                                                    "stacking": {"mode": "normal" if stack else "none"}}},
                            "overrides": []},
            "options": {"legend": {"displayMode": legend, "placement": "bottom"}, "tooltip": {"mode": "multi", "sort": "desc"}}}


def table(title, target, desc="", overrides=None, sort=None):
    return {"type": "table", "title": title, "description": desc, "datasource": target["datasource"], "targets": [target],
            "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}}, "overrides": overrides or []},
            "options": {"showHeader": True, "cellHeight": "sm", "sortBy": sort or []}}


def pie(title, target, unit="short", desc=""):
    return {"type": "piechart", "title": title, "description": desc, "datasource": target["datasource"], "targets": [target],
            "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": "palette-classic"}}, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": True},
                        "pieType": "donut", "legend": {"displayMode": "table", "placement": "right", "values": ["value", "percent"]}}}


def text(title, content):
    return {"type": "text", "title": title, "options": {"mode": "markdown", "content": content}}


def dashboard(uid, title, layout, tags, time="now-24h", variables=None, refresh="30s"):
    return {"uid": uid, "title": title, "tags": tags, "timezone": "browser", "schemaVersion": 39, "version": 1,
            "editable": True, "refresh": refresh, "time": {"from": time, "to": "now"},
            "templating": {"list": variables or []}, "annotations": {"list": []}, "panels": layout.panels,
            "links": [{"title": "VijayBank dashboards", "type": "dashboards", "tags": ["vijaybank"], "asDropdown": True}]}


GREEN, AMBER, RED, NAVY, SAFFRON = "#22A55B", "#F59F00", "#E5484D", "#6EA8FE", "#F07A2E"  # NAVY = neutral, light enough for dark theme
INR = "currencyINR"


# =============================================================== Business
def business():
    L = Layout()
    L.add(text("", "**VijayBank business overview** — read straight from the bank's databases (read-only user `grafana_ro`). "
                   "Amounts are in rupees; time-based panels follow the time picker (top right)."), 24, 2)

    L.row("Money movement")
    done = "status IN ('COMPLETED','PROCESSING')"
    L.add(stat("Transfers", sql("transfer", f"SELECT count(*) FROM transfers WHERE {done} AND $__timeFilter(created_at)"),
               desc="Confirmed transfers in the selected time range (all modes)."), 4, 4)
    L.add(stat("Amount transferred", sql("transfer", f"SELECT COALESCE(sum(amount_paise),0)/100.0 FROM transfers WHERE {done} AND $__timeFilter(created_at)"),
               unit=INR, decimals=0, thresholds=[{"color": SAFFRON, "value": None}]), 5, 4)
    L.add(stat("Success rate", sql("transfer", """SELECT 100.0 * count(*) FILTER (WHERE status = 'COMPLETED')
                 / NULLIF(count(*) FILTER (WHERE status IN ('COMPLETED','FAILED','BLOCKED')), 0)
               FROM transfers WHERE $__timeFilter(created_at)"""),
               unit="percent", decimals=1, desc="Completed / (completed + failed + blocked).",
               thresholds=[{"color": RED, "value": None}, {"color": AMBER, "value": 95}, {"color": GREEN, "value": 99}]), 4, 4)
    L.add(stat("Blocked by fraud check", sql("transfer", "SELECT count(*) FROM transfers WHERE status = 'BLOCKED' AND $__timeFilter(created_at)"),
               thresholds=[{"color": GREEN, "value": None}, {"color": RED, "value": 1}]), 4, 4)
    L.add(stat("Failed / reversed", sql("transfer", "SELECT count(*) FROM transfers WHERE status = 'FAILED' AND $__timeFilter(created_at)"),
               thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 1}]), 4, 4)
    L.add(stat("Avg transfer", sql("transfer", f"SELECT COALESCE(avg(amount_paise),0)/100.0 FROM transfers WHERE {done} AND $__timeFilter(created_at)"),
               unit=INR, decimals=0), 3, 4)

    L.add(ts("Transfers per hour by mode", sql("transfer", f"""SELECT $__timeGroupAlias(created_at, '1h', 0), mode AS metric, count(*) AS value
               FROM transfers WHERE {done} AND $__timeFilter(created_at) GROUP BY 1, 2 ORDER BY 1""", fmt="time_series"),
             bars=True, stack=True), 12, 8)
    L.add(pie("Amount by mode", sql("transfer", f"""SELECT mode AS metric, sum(amount_paise)/100.0 AS value FROM transfers
               WHERE {done} AND $__timeFilter(created_at) GROUP BY mode ORDER BY 2 DESC"""), unit=INR), 6, 8)
    L.add(pie("Outcome", sql("transfer", """SELECT status AS metric, count(*) AS value FROM transfers
               WHERE status <> 'OTP_REQUIRED' AND $__timeFilter(created_at) GROUP BY status""")), 6, 8)
    L.add(table("Latest transfers", sql("transfer", """SELECT created_at AS "Time", reference AS "Reference", mode AS "Mode",
               beneficiary_name AS "Beneficiary", amount_paise/100.0 AS "Amount", status AS "Status", failure_reason AS "Reason"
               FROM transfers WHERE status <> 'OTP_REQUIRED' ORDER BY created_at DESC LIMIT 15"""),
                overrides=[{"matcher": {"id": "byName", "options": "Amount"}, "properties": [{"id": "unit", "value": INR}]},
                           {"matcher": {"id": "byName", "options": "Status"}, "properties": [
                               {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                               {"id": "mappings", "value": [{"type": "value", "options": {
                                   "COMPLETED": {"color": GREEN}, "PROCESSING": {"color": AMBER},
                                   "FAILED": {"color": RED}, "BLOCKED": {"color": RED}}}]}]}]), 24, 8)

    L.row("Bill payments, deposits and cards")
    L.add(stat("Bills paid", sql("payment", "SELECT count(*) FROM bill_payments WHERE status = 'COMPLETED' AND $__timeFilter(created_at)")), 4, 4)
    L.add(stat("Bill amount", sql("payment", "SELECT COALESCE(sum(amount_paise),0)/100.0 FROM bill_payments WHERE status = 'COMPLETED' AND $__timeFilter(created_at)"),
               unit=INR, decimals=0, thresholds=[{"color": SAFFRON, "value": None}]), 4, 4)
    L.add(stat("Active fixed deposits", sql("account", "SELECT count(*) FROM fixed_deposits WHERE status = 'ACTIVE'"),
               desc="All active FDs (not time-filtered)."), 4, 4)
    L.add(stat("Money in fixed deposits", sql("account", "SELECT COALESCE(sum(principal_paise),0)/100.0 FROM fixed_deposits WHERE status = 'ACTIVE'"),
               unit=INR, decimals=0, thresholds=[{"color": SAFFRON, "value": None}]), 4, 4)
    L.add(stat("Cards blocked", sql("card", "SELECT count(*) FROM cards WHERE status <> 'ACTIVE'"),
               desc="Temporarily blocked + reported lost/stolen (current).", thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(stat("International enabled", sql("card", "SELECT count(*) FROM cards WHERE international_enabled AND status = 'ACTIVE'")), 4, 4)
    L.add(pie("Bill payments by category", sql("payment", """SELECT category AS metric, sum(amount_paise)/100.0 AS value FROM bill_payments
               WHERE status = 'COMPLETED' AND $__timeFilter(created_at) GROUP BY category"""), unit=INR), 8, 8)
    L.add(pie("Fixed deposits by tenure", sql("account", """SELECT tenure_months || ' months' AS metric, sum(principal_paise)/100.0 AS value
               FROM fixed_deposits WHERE status = 'ACTIVE' GROUP BY tenure_months ORDER BY tenure_months"""), unit=INR), 8, 8)
    L.add(pie("Cards by status", sql("card", "SELECT type || ' · ' || status AS metric, count(*) AS value FROM cards GROUP BY 1")), 8, 8)

    L.row("Customers and security")
    L.add(stat("Customers logged in", sql("auth", "SELECT count(*) FROM credentials WHERE $__timeFilter(last_login_at)"),
               desc="Distinct customers whose last successful login falls in the time range."), 6, 4)
    L.add(stat("Logins locked now", sql("auth", "SELECT count(*) FROM credentials WHERE locked_until > now()"),
               desc="Customers locked out after 5 wrong passwords.", thresholds=[{"color": GREEN, "value": None}, {"color": RED, "value": 1}]), 6, 4)
    L.add(stat("New beneficiaries", sql("transfer", "SELECT count(*) FROM beneficiaries WHERE status = 'ACTIVE' AND $__timeFilter(created_at)")), 6, 4)
    L.add(stat("Customer deposits (ledger)", sql("ledger", "SELECT sum(balance_paise)/100.0 FROM ledger_accounts WHERE owner_type = 'CUSTOMER'"),
               unit=INR, decimals=0, desc="Sum of all customer account balances — the bank's total deposits.",
               thresholds=[{"color": SAFFRON, "value": None}]), 6, 4)
    L.row("OTP")
    sent, ok = "vijaybank_otp_sent_total", 'vijaybank_otp_verifications_total{result="SUCCESS"}'
    otp = 'vijaybank_otp_verifications_total{result!="SUCCESS"}'
    L.add(stat("OTP sent", prom(f"round(sum(increase({sent}[$__range])))", instant=True), decimals=0,
               desc="OTPs sent by SMS (simulated) in the time range: login and step-up (beneficiary, transfer, bill pay, cards)."), 8, 4)
    L.add(stat("OTP verified", prom(f"round(sum(increase({ok}[$__range])))", instant=True), decimals=0,
               desc="OTPs entered correctly in the time range.", thresholds=[{"color": GREEN, "value": None}]), 8, 4)
    L.add(stat("OTP failed", prom(f"round(sum(increase({otp}[$__range])))", instant=True), decimals=0,
               desc="Wrong, expired or exhausted OTPs in the time range. Alert rule: VijayBank → OTP failures.",
               thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 1}, {"color": RED, "value": 10}]), 8, 4)
    flow = ts("OTP sent, verified and failed", [
        prom(f"sum(increase({sent}[$__rate_interval]))", "Sent"),
        prom(f"sum(increase({ok}[$__rate_interval]))", "Verified"),
        prom(f"sum(increase({otp}[$__rate_interval]))", "Failed")], bars=True,
        desc="Sent minus verified minus failed = OTPs not entered yet or abandoned.")
    flow["fieldConfig"]["overrides"] = [{"matcher": {"id": "byName", "options": n}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}]}
                                        for n, c in (("Sent", NAVY), ("Verified", GREEN), ("Failed", RED))]
    L.add(flow, 12, 8)
    L.add(ts("OTP failures by purpose and reason", prom(f"sum by (purpose, result) (increase({otp}[$__rate_interval]))", "{{purpose}} · {{result}}"),
             bars=True, stack=True, desc="Source: auth-service counter vijaybank.otp.verifications."), 12, 8)
    return dashboard("vb-business", "VijayBank — Business", L, ["vijaybank", "business"], time="now-7d", refresh="1m")


# =============================================================== APM
def apm():
    L = Layout()
    sel = 'service_name=~"$service", span_kind="SPAN_KIND_SERVER", span_name!~"GET /health.*"'
    L.add(text("", "**Application performance** — RED metrics derived from traces by the Collector's *spanmetrics* connector, JVM runtime "
                   "metrics from the Java agent, slow traces from Tempo. Logs are in Kibana (http://localhost:5601). Services appear here as you instrument them."), 24, 2)

    L.row("Service health")
    L.add({"type": "stat", "title": "Bank services", "datasource": PROM,
           "description": "Blackbox exporter calls each service's /health/ready every 15 s.",
           "targets": [prom('min by (service) (probe_success{job="bank-services"})', "{{service}}", instant=True)],
           "fieldConfig": {"defaults": {"mappings": [{"type": "value", "options": {"0": {"text": "DOWN", "color": RED}, "1": {"text": "UP", "color": GREEN}}}],
                                        "color": {"mode": "thresholds"}, "thresholds": {"mode": "absolute", "steps": [{"color": RED, "value": None}, {"color": GREEN, "value": 1}]}},
                           "overrides": []},
           "options": {"reduceOptions": {"calcs": ["lastNotNull"], "values": False}, "colorMode": "background", "textMode": "value_and_name",
                       "graphMode": "none", "orientation": "auto"}}, 24, 6)

    calls, dur = "traces_span_metrics_calls_total", "traces_span_metrics_duration_milliseconds"
    err = f'{sel}, status_code="STATUS_CODE_ERROR"'
    # Apdex with T = 200 ms: satisfied <= 200 ms, tolerating <= 800 ms (4T); both are spanmetrics bucket bounds.
    apdex = lambda by, w: (f'(sum{by} (rate({dur}_bucket{{{sel}, le="200.0"}}[{w}])) + sum{by} (rate({dur}_bucket{{{sel}, le="800.0"}}[{w}]))) '
                           f'/ 2 / (sum{by} (rate({dur}_count{{{sel}}}[{w}])) > 0)')

    L.row("Services overview")
    by = " by (service_name)"
    cols = [  # (refId, header, query, unit, decimals)
        ("A", "Health", 'min by (service_name) (label_replace(probe_success{job="bank-services", service=~"$service"}, "service_name", "$1", "service", "(.*)"))', "none", 0),
        ("B", "Throughput (rpm)", f"60 * sum{by} (rate({calls}{{{sel}}}[5m]))", "reqpm", 1),
        ("C", "Avg response (ms)", f"sum{by} (rate({dur}_sum{{{sel}}}[5m])) / (sum{by} (rate({dur}_count{{{sel}}}[5m])) > 0)", "ms", 0),
        ("D", "p95 (ms)", f"histogram_quantile(0.95, sum by (le, service_name) (rate({dur}_bucket{{{sel}}}[5m]))) >= 0", "ms", 0),
        ("E", "Error %", f"100 * (sum{by} (rate({calls}{{{err}}}[5m])) or 0 * sum{by} (rate({calls}{{{sel}}}[5m]))) / (sum{by} (rate({calls}{{{sel}}}[5m])) > 0)", "percent", 2),
        ("F", "Transactions", f"round(sum{by} (increase({calls}{{{sel}}}[$__range])))", "none", 0),
        ("G", "Errors", f"round(sum{by} (increase({calls}{{{err}}}[$__range])) or 0 * sum{by} (increase({calls}{{{sel}}}[$__range])))", "none", 0),
        ("H", "Apdex", apdex(by, "5m"), "none", 2),
    ]
    bg = lambda steps: [{"id": "custom.cellOptions", "value": {"type": "color-background"}},
                        {"id": "thresholds", "value": {"mode": "absolute", "steps": steps}}]
    # Coloured text (not background) so empty cells stay empty.
    fg = lambda steps: [{"id": "custom.cellOptions", "value": {"type": "color-text"}},
                        {"id": "thresholds", "value": {"mode": "absolute", "steps": steps}}]
    cell_colors = {
        "Health": [{"id": "mappings", "value": [{"type": "value", "options": {"0": {"text": "DOWN", "color": RED}, "1": {"text": "UP", "color": GREEN}}}]},
                   {"id": "custom.cellOptions", "value": {"type": "color-background"}}],
        "p95 (ms)": fg([{"color": GREEN, "value": None}, {"color": AMBER, "value": 300}, {"color": RED, "value": 1000}]),
        "Error %": fg([{"color": GREEN, "value": None}, {"color": AMBER, "value": 1}, {"color": RED, "value": 5}]),
        "Apdex": fg([{"color": RED, "value": None}, {"color": AMBER, "value": 0.7}, {"color": GREEN, "value": 0.94}]),
    }
    L.add({"type": "table", "title": "Services — throughput, response time, errors, Apdex", "datasource": PROM,
           "description": "One row per service. Rates use the last 5 minutes; Transactions and Errors cover the dashboard time range. "
                          "A transaction is one incoming request (server span). Apdex T = 200 ms: 1.0 = every request under 200 ms. "
                          "Empty cells: no requests in the last 5 minutes, or the service is not instrumented yet (Go and .NET: Phase 5 Step 4).",
           "targets": [{**prom(q, instant=True, fmt="table"), "refId": r} for r, _, q, _, _ in cols],
           "transformations": [{"id": "merge", "options": {}},
                               {"id": "organize", "options": {"excludeByName": {"Time": True}, "renameByName": {"service_name": "Service"}}}],
           "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}},
                           "overrides": [{"matcher": {"id": "byName", "options": f"Value #{r}"},
                                          "properties": [{"id": "displayName", "value": h}, {"id": "unit", "value": u}, {"id": "decimals", "value": d}]
                                                        + cell_colors.get(h, [])} for r, h, _, u, d in cols]},
           "options": {"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "Throughput (rpm)", "desc": True}]}}, 24, 16)

    L.row("Golden signals")
    L.add(stat("Throughput", prom(f"60 * sum(rate({calls}{{{sel}}}[5m]))"), unit="reqpm", decimals=1,
               desc="Requests per minute (rpm) over the last 5 minutes."), 4, 4)
    L.add(stat("Transactions", prom(f"round(sum(increase({calls}{{{sel}}}[$__range])))", instant=True), decimals=0,
               desc="Incoming requests in the dashboard time range."), 4, 4)
    L.add(stat("Avg response", prom(f"sum(rate({dur}_sum{{{sel}}}[5m])) / (sum(rate({dur}_count{{{sel}}}[5m])) > 0)"), unit="ms", decimals=0,
               thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 200}, {"color": RED, "value": 800}]), 4, 4)
    L.add(stat("p95 latency", prom(f"histogram_quantile(0.95, sum by (le) (rate({dur}_bucket{{{sel}}}[5m]))) >= 0"),
               unit="ms", decimals=0, thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 300}, {"color": RED, "value": 1000}]), 4, 4)
    L.add(stat("Error rate", prom(f"100 * (sum(rate({calls}{{{err}}}[5m])) or vector(0)) / (sum(rate({calls}{{{sel}}}[5m])) > 0)"),
               unit="percent", decimals=2, thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 1}, {"color": RED, "value": 5}]), 4, 4)
    L.add(stat("Apdex", prom(apdex("", "5m")), decimals=2, desc="T = 200 ms. 1.0 = all requests satisfied; below 0.7 users notice slowness.",
               thresholds=[{"color": RED, "value": None}, {"color": AMBER, "value": 0.7}, {"color": GREEN, "value": 0.94}]), 4, 4)

    L.add(ts("Throughput (rpm) by service", prom(f"60 * sum{by} (rate({calls}{{{sel}}}[5m]))", "{{service_name}}"), unit="reqpm"), 12, 8)
    L.add(ts("Average response time by service", prom(f"sum{by} (rate({dur}_sum{{{sel}}}[5m])) / sum{by} (rate({dur}_count{{{sel}}}[5m]))",
                                                       "{{service_name}}"), unit="ms"), 12, 8)
    L.add(ts("p95 latency by service (dots = exemplars → click to open the trace)",
             prom(f"histogram_quantile(0.95, sum by (le, service_name) (rate({dur}_bucket{{{sel}}}[5m])))",
                  "{{service_name}}", exemplar=True), unit="ms"), 12, 8)
    L.add(ts("Error % by service", prom(f"100 * (sum{by} (rate({calls}{{{err}}}[5m])) "
                                        f"or 0 * sum{by} (rate({calls}{{{sel}}}[5m]))) "
                                        f"/ sum{by} (rate({calls}{{{sel}}}[5m]))", "{{service_name}}"),
             unit="percent", desc="Server spans marked as errors (5xx). 4xx responses such as a wrong OTP are not errors."), 12, 8)

    L.add(table("Top transactions — busiest endpoints (last hour)", {**prom(
        f"""round(sum by (service_name, span_name) (increase(traces_span_metrics_calls_total{{{sel}}}[1h]))) > 0""", instant=True, fmt="table")},
        desc="Requests per endpoint over the last hour, highest first.",
        overrides=[{"matcher": {"id": "byName", "options": "Value"}, "properties": [{"id": "displayName", "value": "Requests (1h)"}, {"id": "decimals", "value": 0}]},
                   {"matcher": {"id": "byName", "options": "Time"}, "properties": [{"id": "custom.hidden", "value": True}]}],
        sort=[{"displayName": "Requests (1h)", "desc": True}]), 12, 9)
    L.add(table("Slowest endpoints — p95 ms (last hour)", prom(
        f"topk(15, histogram_quantile(0.95, sum by (le, service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_bucket{{{sel}}}[1h]))) > 0)",
        instant=True, fmt="table"),
        overrides=[{"matcher": {"id": "byName", "options": "Value"}, "properties": [{"id": "displayName", "value": "p95 (ms)"}, {"id": "decimals", "value": 0},
                                                                                     {"id": "custom.cellOptions", "value": {"type": "color-background"}},
                                                                                     {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                                                                                         {"color": GREEN, "value": None}, {"color": AMBER, "value": 300}, {"color": RED, "value": 1000}]}}]},
                   {"matcher": {"id": "byName", "options": "Time"}, "properties": [{"id": "custom.hidden", "value": True}]}],
        sort=[{"displayName": "p95 (ms)", "desc": True}]), 12, 9)

    L.row("Outgoing calls — databases, HTTP, messaging")
    osel = 'service_name=~"$service", span_kind=~"SPAN_KIND_CLIENT|SPAN_KIND_PRODUCER"'
    oby = " by (service_name, span_name, span_kind)"
    L.add({"type": "table", "title": "Calls each service makes (last hour) — slowest first", "datasource": PROM,
           "description": "Client and producer spans: SQL queries, Redis commands, HTTP calls to other services, RabbitMQ publishes.",
           "targets": [{**prom(f"sum{oby} (increase({calls}{{{osel}}}[1h])) / 60 > 0", instant=True, fmt="table"), "refId": "A"},
                       {**prom(f"sum{oby} (rate({dur}_sum{{{osel}}}[1h])) / sum{oby} (rate({dur}_count{{{osel}}}[1h]))", instant=True, fmt="table"), "refId": "B"}],
           "transformations": [{"id": "merge", "options": {}},
                               {"id": "filterByValue", "options": {"type": "exclude", "match": "any",
                                                                   "filters": [{"fieldName": "Value #A", "config": {"id": "isNull", "options": {}}}]}},
                               {"id": "organize", "options": {"excludeByName": {"Time": True},
                                                              "renameByName": {"service_name": "Service", "span_name": "Call", "span_kind": "Kind"}}}],
           "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}},
                           "overrides": [{"matcher": {"id": "byName", "options": "Value #A"},
                                          "properties": [{"id": "displayName", "value": "Calls / min"}, {"id": "decimals", "value": 2}]},
                                         {"matcher": {"id": "byName", "options": "Value #B"},
                                          "properties": [{"id": "displayName", "value": "Avg (ms)"}, {"id": "unit", "value": "ms"}, {"id": "decimals", "value": 1}]
                                                        + bg([{"color": GREEN, "value": None}, {"color": AMBER, "value": 50}, {"color": RED, "value": 200}])},
                                         {"matcher": {"id": "byName", "options": "Kind"},
                                          "properties": [{"id": "mappings", "value": [{"type": "value", "options": {
                                              "SPAN_KIND_CLIENT": {"text": "client"}, "SPAN_KIND_PRODUCER": {"text": "publish"}}}]}]}]},
           "options": {"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "Avg (ms)", "desc": True}]}}, 14, 10)
    L.add(ts("Time spent in outgoing calls by service", prom(f"sum{by} (rate({dur}_sum{{{osel}}}[5m])) / 1000", "{{service_name}}"),
             unit="s", stack=True, desc="Seconds per second spent waiting on databases, caches, other services and RabbitMQ."), 10, 10)

    L.row("JVM runtime (Java & Kotlin services)")
    jsel = 'service_name=~"$service"'
    L.add(ts("Heap used", prom(f'sum by (service_name) (jvm_memory_used_bytes{{{jsel}, jvm_memory_type="heap"}})', "{{service_name}}"), unit="bytes"), 6, 7)
    L.add(ts("GC pause time per second", prom(f"sum by (service_name) (rate(jvm_gc_duration_seconds_sum{{{jsel}}}[5m]))", "{{service_name}}"),
             unit="s", desc="Seconds spent in garbage collection per second of wall time."), 6, 7)
    L.add(ts("JVM CPU utilisation", prom(f"avg by (service_name) (jvm_cpu_recent_utilization_ratio{{{jsel}}})", "{{service_name}}"), unit="percentunit"), 6, 7)
    L.add(ts("Live threads", prom(f"sum by (service_name) (jvm_thread_count{{{jsel}}})", "{{service_name}}")), 6, 7)

    L.row("Traces")
    L.add({"type": "table", "title": "Slow requests (> 200 ms) — click a Trace ID", "datasource": TEMPO,
           "targets": [{"datasource": TEMPO, "queryType": "traceql", "limit": 20, "tableType": "traces", "refId": "A",
                        "query": '{ kind = server && duration > 200ms && name !~ "GET /health.*" }'}],
           "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"showHeader": True}}, 24, 10)

    service_var = {"name": "service", "label": "Service", "type": "query", "datasource": PROM,
                   "query": {"query": "label_values(traces_span_metrics_calls_total, service_name)", "refId": "A"},
                   "regex": "/^(?!telemetrygen).*/", "refresh": 2, "includeAll": True, "multi": True, "allValue": ".*",
                   "current": {"selected": True, "text": ["All"], "value": ["$__all"]}, "sort": 1}
    return dashboard("vb-apm", "VijayBank — APM", L, ["vijaybank", "apm"], time="now-1h", variables=[service_var])


# =============================================================== Infrastructure
def infrastructure():
    L = Layout()
    c = 'container_label_com_docker_compose_project="vijaybank"'
    by = "container_label_com_docker_compose_service"
    L.add(text("", "**Infrastructure** — containers (cAdvisor), PostgreSQL, Redis, RabbitMQ and MongoDB exporters, and the health of "
                   "every Prometheus scrape target."), 24, 2)

    L.row("Scrape health")
    L.add({"type": "stat", "title": "Targets up", "datasource": PROM, "targets": [prom('min by (job) (up{job!="bank-services"}) '
                                                                                  # the 14 bank-services probes all go through one exporter: show it once
                                                                                  'or label_replace(min(up{job="bank-services"}), "job", "blackbox-exporter", "", "")',
                                                                                  "{{job}}", instant=True)],
           "fieldConfig": {"defaults": {"mappings": [{"type": "value", "options": {"0": {"text": "DOWN", "color": RED}, "1": {"text": "UP", "color": GREEN}}}],
                                        "color": {"mode": "thresholds"}, "thresholds": {"mode": "absolute", "steps": [{"color": RED, "value": None}, {"color": GREEN, "value": 1}]}},
                           "overrides": []},
           "options": {"reduceOptions": {"calcs": ["lastNotNull"], "values": False}, "colorMode": "background", "textMode": "value_and_name",
                       "graphMode": "none", "orientation": "vertical"}}, 24, 4)

    L.row("Containers")
    L.add(ts("CPU by container (cores)", prom(f"sum by ({by}) (rate(container_cpu_usage_seconds_total{{{c}}}[2m]))", f"{{{{{by}}}}}"), unit="short", legend="table"), 12, 9)
    L.add(ts("Memory by container (working set)", prom(f"sum by ({by}) (container_memory_working_set_bytes{{{c}}})", f"{{{{{by}}}}}"), unit="bytes", legend="table"), 12, 9)
    L.add(ts("Network received", prom(f"sum by ({by}) (rate(container_network_receive_bytes_total{{{c}}}[2m]))", f"{{{{{by}}}}}"), unit="Bps"), 12, 7)
    L.add(table("Top memory users", prom(f"topk(10, sum by ({by}) (container_memory_working_set_bytes{{{c}}}))", instant=True, fmt="table"),
                overrides=[{"matcher": {"id": "byName", "options": "Value"}, "properties": [{"id": "unit", "value": "bytes"}, {"id": "displayName", "value": "Memory"}]},
                           {"matcher": {"id": "byName", "options": "Time"}, "properties": [{"id": "custom.hidden", "value": True}]}],
                sort=[{"displayName": "Memory", "desc": True}]), 12, 7)

    L.row("PostgreSQL")
    dbs = 'datname=~"auth|customer|account|ledger|transfer|payment|card"'
    L.add(stat("Connections", prom(f"sum(pg_stat_database_numbackends{{{dbs}}})"), thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(stat("Commits / s", prom(f"sum(rate(pg_stat_database_xact_commit{{{dbs}}}[2m]))"), decimals=1, thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(stat("Rollbacks / s", prom(f"sum(rate(pg_stat_database_xact_rollback{{{dbs}}}[2m]))"), decimals=2,
               thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 0.5}]), 4, 4)
    L.add(stat("Cache hit ratio", prom(f"sum(rate(pg_stat_database_blks_hit{{{dbs}}}[5m])) / (sum(rate(pg_stat_database_blks_hit{{{dbs}}}[5m])) + sum(rate(pg_stat_database_blks_read{{{dbs}}}[5m])))"),
               unit="percentunit", decimals=2, thresholds=[{"color": RED, "value": None}, {"color": AMBER, "value": 0.9}, {"color": GREEN, "value": 0.98}]), 4, 4)
    L.add(stat("Deadlocks", prom(f"sum(increase(pg_stat_database_deadlocks{{{dbs}}}[1h]))"), thresholds=[{"color": GREEN, "value": None}, {"color": RED, "value": 1}]), 4, 4)
    L.add(stat("Total size", prom(f"sum(pg_database_size_bytes{{{dbs}}})"), unit="bytes", thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(ts("Transactions / s by database", prom(f"sum by (datname) (rate(pg_stat_database_xact_commit{{{dbs}}}[2m]))", "{{datname}}")), 12, 7)
    L.add(ts("Connections by database", prom(f"sum by (datname) (pg_stat_database_numbackends{{{dbs}}})", "{{datname}}")), 12, 7)

    L.row("RabbitMQ")
    q = 'queue!~".*dlq"'
    L.add(stat("Messages waiting", prom(f"sum(rabbitmq_detailed_queue_messages_ready{{{q}}})"), thresholds=[{"color": GREEN, "value": None}, {"color": AMBER, "value": 50}, {"color": RED, "value": 500}]), 4, 4)
    L.add(stat("Dead-lettered", prom('sum(rabbitmq_detailed_queue_messages_ready{queue=~".*dlq"})'),
               desc="Messages that failed processing 3 times. Should always be 0.", thresholds=[{"color": GREEN, "value": None}, {"color": RED, "value": 1}],
               color_mode="background"), 4, 4)
    L.add(stat("Publishes / s", prom("sum(rate(rabbitmq_global_messages_received_total[2m]))"), decimals=2, thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(stat("Deliveries / s", prom("sum(rate(rabbitmq_global_messages_delivered_total[2m]))"), decimals=2, thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(stat("Consumers", prom("sum(rabbitmq_detailed_queue_consumers)"), thresholds=[{"color": RED, "value": None}, {"color": GREEN, "value": 4}]), 4, 4)
    L.add(stat("Connections", prom("sum(rabbitmq_connections)"), thresholds=[{"color": NAVY, "value": None}]), 4, 4)
    L.add(ts("Messages waiting by queue", [prom(f"sum by (queue) (rabbitmq_detailed_queue_messages_ready{{{q}}})", "{{queue}} ready"),
                                           prom(f"sum by (queue) (rabbitmq_detailed_queue_messages_unacked{{{q}}})", "{{queue}} in progress")]), 12, 7)
    L.add(ts("Publish vs deliver rate", [prom("sum(rate(rabbitmq_global_messages_received_total[2m]))", "published"),
                                        prom("sum(rate(rabbitmq_global_messages_delivered_total[2m]))", "delivered")], unit="short"), 12, 7)

    L.row("Redis and MongoDB")
    L.add(ts("Redis commands / s", prom("sum(rate(redis_commands_processed_total[2m]))", "commands/s")), 6, 7)
    L.add(ts("Redis memory", prom("redis_memory_used_bytes", "used")), 6, 7)
    L.add(ts("MongoDB operations / s", prom("sum by (legacy_op_type) (rate(mongodb_ss_opcounters[2m]))", "{{legacy_op_type}}")), 6, 7)
    L.add(ts("MongoDB connections", prom('mongodb_ss_connections{conn_type="current"}', "current")), 6, 7)
    return dashboard("vb-infra", "VijayBank — Infrastructure", L, ["vijaybank", "infrastructure"], time="now-1h")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, build in [("business", business), ("apm", apm), ("infrastructure", infrastructure)]:
        d = build()
        (OUT / f"{name}.json").write_text(json.dumps(d, indent=2))
        print(f"{name}.json: {sum(1 for p in d['panels'] if p['type'] != 'row')} panels")
