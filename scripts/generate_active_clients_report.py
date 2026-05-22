from __future__ import annotations

import os
import zipfile
from collections import Counter
from datetime import datetime
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
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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


def query_clients(connection: pymysql.Connection) -> list[dict[str, object]]:
    sql = """
        SELECT payload
        FROM RepositoryRecord
        WHERE entityType = 'client'
    """
    with connection.cursor() as cursor:
        cursor.execute(sql)
        rows = cursor.fetchall()

    clients: list[dict[str, object]] = []
    for row in rows:
        payload = row[0]
        if isinstance(payload, str):
            # Defensive fallback; PyMySQL should already decode JSON.
            import json

            payload = json.loads(payload)
        if isinstance(payload, dict):
            clients.append(payload)
    return clients


def is_active(client: dict[str, object]) -> bool:
    return client.get("endDate") in (None, "") and client.get("deathDate") in (None, "")


def rows_for_totals(active_clients: list[dict[str, object]]) -> tuple[list[list[object]], list[list[object]], list[list[object]], list[list[object]]]:
    total_active = len(active_clients)

    by_client_type = Counter((client.get("clientType") or "Unknown") for client in active_clients)
    by_municipality = Counter((client.get("municipality") or "Unknown") for client in active_clients)

    summary_rows = [
        ["Metric", "Value"],
        ["Total active clients", total_active],
        ["Active criteria", "endDate is empty/null and deathDate is empty/null"],
        ["Generated at", datetime.now().isoformat(timespec="seconds")],
    ]

    client_type_rows = [["clientType", "Active clients"]]
    for key, value in sorted(by_client_type.items(), key=lambda item: (-item[1], str(item[0]))):
        client_type_rows.append([key, value])

    municipality_rows = [["municipality", "Active clients"]]
    for key, value in sorted(by_municipality.items(), key=lambda item: (-item[1], str(item[0]))):
        municipality_rows.append([key, value])

    assumptions_rows = [
        ["Assumption", "Value"],
        ["Active definition", "Client is active when endDate is null/empty and deathDate is null/empty."],
        ["Source table", "RepositoryRecord"],
        ["Entity type", "client"],
    ]

    return summary_rows, client_type_rows, municipality_rows, assumptions_rows


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
        for col_idx, value in enumerate(row, start=1):
            cell_ref = f"{col_name(col_idx)}{row_idx}"
            style = ' s="1"' if row_idx == 1 else ""
            if value is None:
                continue
            if isinstance(value, (int, float)) and row_idx != 1:
                cells.append(f'<c r="{cell_ref}"{style}><v>{value}</v></c>')
            else:
                cells.append(
                    f'<c r="{cell_ref}" t="inlineStr"{style}><is><t>{escape(str(value))}</t></is></c>'
                )
        sheet_rows.append(f'<row r="{row_idx}">{"".join(cells)}</row>')

    dimension_ref = f"A1:{col_name(max((len(r) for r in rows), default=1))}{max(len(rows), 1)}"
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="{dimension_ref}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>{''.join(sheet_rows)}</sheetData>
</worksheet>
"""


def workbook_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="By Client Type" sheetId="2" r:id="rId2"/>
    <sheet name="By Municipality" sheetId="3" r:id="rId3"/>
    <sheet name="Assumptions" sheetId="4" r:id="rId4"/>
  </sheets>
</workbook>
"""


def workbook_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
  <dc:title>Active Clients Report</dc:title>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


APP_PROPS_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Excel</Application>
</Properties>
"""


def write_xlsx(path: Path, sheets: Iterable[tuple[str, list[list[object]]]]) -> None:
    sheet_items = list(sheets)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", WORKBOOK_RELS)
        archive.writestr("docProps/core.xml", core_props_xml())
        archive.writestr("docProps/app.xml", APP_PROPS_XML)
        archive.writestr("xl/workbook.xml", workbook_xml())
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml())
        archive.writestr("xl/styles.xml", STYLES_XML)

        for index, (_, rows) in enumerate(sheet_items, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", worksheet_xml(rows))


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    env = load_env(project_root / ".env")
    db_url = env["DATABASE_URL"]
    conn_args = parse_database_url(db_url)
    connection = pymysql.connect(
        host=conn_args["host"],
        port=int(conn_args["port"]),
        user=str(conn_args["user"]),
        password=str(conn_args["password"]),
        database=str(conn_args["database"]),
    )

    try:
        clients = query_clients(connection)
    finally:
        connection.close()

    active_clients = [client for client in clients if is_active(client)]
    summary_rows, client_type_rows, municipality_rows, assumptions_rows = rows_for_totals(active_clients)

    reports_dir = project_root / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_path = reports_dir / "active_clients_report.xlsx"

    write_xlsx(
        report_path,
        [
          ("Summary", summary_rows),
          ("By Client Type", client_type_rows),
          ("By Municipality", municipality_rows),
          ("Assumptions", assumptions_rows),
        ],
    )

    print(report_path)
    print(f"total_active={len(active_clients)}")


if __name__ == "__main__":
    main()
