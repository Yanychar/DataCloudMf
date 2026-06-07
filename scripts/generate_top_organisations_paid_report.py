from __future__ import annotations

import json
import csv
import zipfile
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse
from xml.sax.saxutils import escape

import pymysql


WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"""

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
"""

STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>
"""

APP_PROPS_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Excel</Application>
</Properties>
"""


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def parse_database_url(url: str) -> dict[str, object]:
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "user": parsed.username or "",
        "password": parsed.password or "",
        "database": parsed.path.lstrip("/"),
    }


def decimal_to_float(value: object) -> object:
    if isinstance(value, Decimal):
        return float(value)
    return value


def read_extra(extra_data: object) -> dict[str, object]:
    if isinstance(extra_data, dict):
        return extra_data
    if isinstance(extra_data, str):
        try:
            parsed = json.loads(extra_data)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def query_report_rows(connection: pymysql.Connection) -> tuple[datetime, datetime, list[dict[str, object]], list[dict[str, object]]]:
    amount_expr = "CAST(REPLACE(COALESCE(NULLIF(totalAmount, ''), '0'), ',', '.') AS DECIMAL(18,2))"

    with connection.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute("SELECT MAX(invoiceDate) AS maxInvoiceDate FROM stg_invoice WHERE invoiceDate IS NOT NULL")
        max_invoice_date = cursor.fetchone()["maxInvoiceDate"]
        if max_invoice_date is None:
            return datetime.now(), datetime.now(), [], []

        cursor.execute("SELECT DATE_SUB(%s, INTERVAL 12 MONTH) AS startDate", (max_invoice_date,))
        start_date = cursor.fetchone()["startDate"]

        cursor.execute(
            f"""
            SELECT
              i.payerOrgId AS orgId,
              COALESCE(
                MAX(o.orgName),
                MAX(JSON_UNQUOTE(JSON_EXTRACT(i.extraData, '$.payerName'))),
                CONCAT('Unknown organisation ', i.payerOrgId)
              ) AS orgName,
              COUNT(*) AS invoiceCount,
              SUM({amount_expr}) AS totalAmount,
              MIN(i.invoiceDate) AS firstInvoiceDate,
              MAX(i.invoiceDate) AS lastInvoiceDate
            FROM stg_invoice i
            LEFT JOIN stg_organisation o ON o.orgId = i.payerOrgId
            WHERE i.invoiceStatusId = 2
              AND i.payerOrgId IS NOT NULL
              AND i.invoiceDate >= %s
              AND i.invoiceDate <= %s
            GROUP BY i.payerOrgId
            ORDER BY totalAmount DESC
            LIMIT 100
            """,
            (start_date, max_invoice_date),
        )
        summaries = cursor.fetchall()

        org_ids = [row["orgId"] for row in summaries]
        if not org_ids:
            return start_date, max_invoice_date, [], []

        placeholders = ", ".join(["%s"] * len(org_ids))
        cursor.execute(
            f"""
            SELECT
              i.payerOrgId AS orgId,
              COALESCE(o.orgName, JSON_UNQUOTE(JSON_EXTRACT(i.extraData, '$.payerName')), CONCAT('Unknown organisation ', i.payerOrgId)) AS orgName,
              i.invoiceId,
              i.invoice,
              i.invoiceNbr,
              i.invoiceDate,
              i.dueDate,
              i.modifiedDate,
              {amount_expr} AS totalAmount,
              CAST(REPLACE(COALESCE(NULLIF(i.totalVat, ''), '0'), ',', '.') AS DECIMAL(18,2)) AS totalVat,
              i.invoiceStatusId,
              i.invoiceStatusDescr,
              i.extraData
            FROM stg_invoice i
            LEFT JOIN stg_organisation o ON o.orgId = i.payerOrgId
            WHERE i.invoiceStatusId = 2
              AND i.payerOrgId IN ({placeholders})
              AND i.invoiceDate >= %s
              AND i.invoiceDate <= %s
            ORDER BY FIELD(i.payerOrgId, {placeholders}), i.invoiceDate, i.invoiceId
            """,
            (*org_ids, start_date, max_invoice_date, *org_ids),
        )
        invoices = cursor.fetchall()

    rank_by_org_id = {row["orgId"]: rank for rank, row in enumerate(summaries, start=1)}
    for row in summaries:
        row["rank"] = rank_by_org_id[row["orgId"]]
        row["totalAmount"] = decimal_to_float(row["totalAmount"])

    for row in invoices:
        extra = read_extra(row.pop("extraData", None))
        row["rank"] = rank_by_org_id[row["orgId"]]
        row["payerName"] = extra.get("payerName", "")
        row["payerLyNumber"] = extra.get("payerLyNumber", "")
        row["ourRefNbr"] = extra.get("ourRefNbr", "")
        row["paymentTerm"] = extra.get("paymentTerm", "")
        row["totalAmount"] = decimal_to_float(row["totalAmount"])
        row["totalVat"] = decimal_to_float(row["totalVat"])

    return start_date, max_invoice_date, summaries, invoices


def format_cell(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    return value


def date_label(value: object) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value)


def col_name(index: int) -> str:
    result = ""
    current = index
    while current > 0:
        current, rem = divmod(current - 1, 26)
        result = chr(65 + rem) + result
    return result


def worksheet_xml(rows: list[list[object]]) -> str:
    sheet_rows: list[str] = []
    for row_idx, row in enumerate(rows, start=1):
        cells: list[str] = []
        for col_idx, raw_value in enumerate(row, start=1):
            value = format_cell(raw_value)
            cell_ref = f"{col_name(col_idx)}{row_idx}"
            style = ' s="1"' if row_idx == 1 else ""
            if isinstance(value, (int, float)) and not isinstance(value, bool) and row_idx != 1:
                cells.append(f'<c r="{cell_ref}"{style}><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{cell_ref}" t="inlineStr"{style}><is><t>{escape(str(value))}</t></is></c>')
        sheet_rows.append(f'<row r="{row_idx}">{"".join(cells)}</row>')

    dimension_ref = f"A1:{col_name(max((len(row) for row in rows), default=1))}{max(len(rows), 1)}"
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="{dimension_ref}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>{''.join(sheet_rows)}</sheetData>
</worksheet>
"""


def workbook_xml(sheet_names: list[str]) -> str:
    sheets = "\n".join(
        f'    <sheet name="{escape(name)}" sheetId="{idx}" r:id="rId{idx}"/>'
        for idx, name in enumerate(sheet_names, start=1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
{sheets}
  </sheets>
</workbook>
"""


def workbook_rels_xml(sheet_count: int) -> str:
    worksheet_rels = "\n".join(
        f'  <Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>'
        for idx in range(1, sheet_count + 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
{worksheet_rels}
  <Relationship Id="rId{sheet_count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
"""


def core_props_xml() -> str:
    now = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Top Organisations Paid Amount Report</dc:title>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


def write_xlsx(path: Path, sheets: Iterable[tuple[str, list[list[object]]]]) -> None:
    sheet_items = list(sheets)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", WORKBOOK_RELS)
        archive.writestr("docProps/core.xml", core_props_xml())
        archive.writestr("docProps/app.xml", APP_PROPS_XML)
        archive.writestr("xl/workbook.xml", workbook_xml([name for name, _ in sheet_items]))
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml(len(sheet_items)))
        archive.writestr("xl/styles.xml", STYLES_XML)
        for index, (_, rows) in enumerate(sheet_items, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", worksheet_xml(rows))


def write_csv(path: Path, rows: list[list[object]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        for row in rows:
            writer.writerow([format_cell(value) for value in row])


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    env = load_env(project_root / ".env")
    conn_args = parse_database_url(env["DATABASE_URL"])
    connection = pymysql.connect(
        host=conn_args["host"],
        port=int(conn_args["port"]),
        user=str(conn_args["user"]),
        password=str(conn_args["password"]),
        database=str(conn_args["database"]),
    )

    try:
        start_date, max_invoice_date, summaries, invoices = query_report_rows(connection)
    finally:
        connection.close()

    summary_rows = [
        ["Rank", "Organisation ID", "Organisation name", "Approved invoice total", "Invoice count", "First invoice date", "Last invoice date"],
        *[
            [
                row["rank"],
                row["orgId"],
                row["orgName"],
                row["totalAmount"],
                row["invoiceCount"],
                row["firstInvoiceDate"],
                row["lastInvoiceDate"],
            ]
            for row in summaries
        ],
    ]
    invoice_rows = [
        [
            "Rank",
            "Organisation ID",
            "Organisation name",
            "Invoice ID",
            "Invoice URI",
            "Invoice number",
            "Invoice date",
            "Due date",
            "Modified date",
            "Invoice total",
            "VAT total",
            "Status ID",
            "Status",
            "Payer name",
            "Payer business ID",
            "Our ref",
            "Payment term",
        ],
        *[
            [
                row["rank"],
                row["orgId"],
                row["orgName"],
                row["invoiceId"],
                row["invoice"],
                row["invoiceNbr"],
                row["invoiceDate"],
                row["dueDate"],
                row["modifiedDate"],
                row["totalAmount"],
                row["totalVat"],
                row["invoiceStatusId"],
                row["invoiceStatusDescr"],
                row["payerName"],
                row["payerLyNumber"],
                row["ourRefNbr"],
                row["paymentTerm"],
            ]
            for row in invoices
        ],
    ]
    metadata_rows = [
        ["Metric", "Value"],
        ["Source tables", "stg_invoice joined to stg_organisation"],
        ["Date basis", "MAX(stg_invoice.invoiceDate)"],
        ["Last invoice date in stage", max_invoice_date],
        ["Start date, inclusive", start_date],
        ["End date, inclusive", max_invoice_date],
        ["Paid/accepted filter", "invoiceStatusId = 2 / Hyväksytty"],
        ["Organisations returned", len(summaries)],
        ["Invoice rows returned", len(invoices)],
        ["Generated at", datetime.now().isoformat(sep=" ", timespec="seconds")],
    ]

    reports_dir = project_root / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_path = reports_dir / "top_100_organisations_paid_last_12_months_stage.xlsx"
    summary_csv_path = reports_dir / "top_100_organisations_paid_last_12_months_stage_summary.csv"
    invoices_csv_path = reports_dir / "top_100_organisations_paid_last_12_months_stage_invoices.csv"
    write_xlsx(
        report_path,
        [
            ("Top 100", summary_rows),
            ("Invoices", invoice_rows),
            ("Metadata", metadata_rows),
        ],
    )
    write_csv(summary_csv_path, summary_rows)
    write_csv(invoices_csv_path, invoice_rows)

    print(report_path)
    print(summary_csv_path)
    print(invoices_csv_path)
    print(f"date_range={date_label(start_date)}..{date_label(max_invoice_date)}")
    print(f"organisations={len(summaries)}")
    print(f"invoices={len(invoices)}")
    for row in summaries[:10]:
        print(f"{row['rank']:>3}. {row['orgName']} ({row['orgId']}): {row['totalAmount']:.2f} / {row['invoiceCount']} invoices")


if __name__ == "__main__":
    main()
