from __future__ import annotations

import base64
import io
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload

SCOPES = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/drive.file",
]

PENDING_STATES = {"NEW", "CREATED", "RECLAIMED_BY_STUDENT"}
COMPLETED_STATES = {"TURNED_IN", "RETURNED"}
DEFAULT_TIMEZONE = "America/Mexico_City"
DRIVE_FOLDER_NAME = "ChatGPT Classroom Bridge"
DRIVE_JSON_NAME = "ChatGPT_Classroom_Pendientes.json"
DRIVE_MARKDOWN_NAME = "ChatGPT_Classroom_Pendientes.md"


@dataclass(frozen=True)
class SyncResult:
    pending_count: int
    overdue_count: int
    course_count: int
    json_file_id: str
    markdown_file_id: str


def load_credentials() -> Credentials:
    encoded = os.environ.get("GOOGLE_TOKEN_JSON_B64", "").strip()
    if not encoded:
        raise RuntimeError(
            "Falta el secreto GOOGLE_TOKEN_JSON_B64. Ejecuta authorize_google.py y "
            "guarda el valor generado como GitHub Actions secret."
        )

    try:
        token_info = json.loads(base64.b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("GOOGLE_TOKEN_JSON_B64 no contiene un token OAuth válido.") from exc

    credentials = Credentials.from_authorized_user_info(token_info, SCOPES)
    if credentials.expired:
        if not credentials.refresh_token:
            raise RuntimeError("El token OAuth venció y no contiene refresh_token.")
        credentials.refresh(Request())
    if not credentials.valid:
        raise RuntimeError("Las credenciales de Google no son válidas.")
    return credentials


def paginate(request_factory: Callable[[str | None], Any], item_key: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        response = request_factory(page_token).execute()
        items.extend(response.get(item_key, []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return items


def due_datetime_utc(coursework: dict[str, Any]) -> datetime | None:
    due_date = coursework.get("dueDate")
    due_time = coursework.get("dueTime")
    if not due_date:
        return None

    hour = int((due_time or {}).get("hours", 23))
    minute = int((due_time or {}).get("minutes", 59))
    second = int((due_time or {}).get("seconds", 59))
    return datetime(
        int(due_date["year"]),
        int(due_date["month"]),
        int(due_date["day"]),
        hour,
        minute,
        second,
        tzinfo=timezone.utc,
    )


def classify_status(
    due_at: datetime | None,
    now_utc: datetime,
    local_tz: ZoneInfo | timezone = timezone.utc,
) -> str:
    if due_at is None:
        return "sin_fecha"
    if due_at < now_utc:
        return "atrasada"
    if due_at.astimezone(local_tz).date() == now_utc.astimezone(local_tz).date():
        return "vence_hoy"
    return "proxima"


def submission_is_pending(submission: dict[str, Any] | None) -> bool:
    if submission is None:
        return True
    state = submission.get("state", "NEW")
    if state in COMPLETED_STATES:
        return False
    return state in PENDING_STATES or state not in COMPLETED_STATES


def collect_pending_tasks(classroom: Any, tz_name: str = DEFAULT_TIMEZONE) -> dict[str, Any]:
    local_tz = ZoneInfo(tz_name)
    now_utc = datetime.now(timezone.utc)

    courses = paginate(
        lambda token: classroom.courses().list(
            studentId="me",
            courseStates=["ACTIVE"],
            pageSize=100,
            pageToken=token,
        ),
        "courses",
    )

    tasks: list[dict[str, Any]] = []
    course_errors: list[dict[str, str]] = []

    for course in courses:
        course_id = course["id"]
        course_name = course.get("name", "Curso sin nombre")
        try:
            coursework_items = paginate(
                lambda token, cid=course_id: classroom.courses().courseWork().list(
                    courseId=cid,
                    courseWorkStates=["PUBLISHED"],
                    orderBy="dueDate asc,updateTime desc",
                    pageSize=100,
                    pageToken=token,
                ),
                "courseWork",
            )
            submissions = paginate(
                lambda token, cid=course_id: classroom.courses()
                .courseWork()
                .studentSubmissions()
                .list(
                    courseId=cid,
                    courseWorkId="-",
                    userId="me",
                    pageSize=100,
                    pageToken=token,
                ),
                "studentSubmissions",
            )
        except HttpError as exc:
            course_errors.append({"course": course_name, "error": str(exc)[:300]})
            continue

        submissions_by_work = {
            submission.get("courseWorkId"): submission
            for submission in submissions
            if submission.get("courseWorkId")
        }

        for work in coursework_items:
            submission = submissions_by_work.get(work.get("id"))
            if not submission_is_pending(submission):
                continue

            due_utc = due_datetime_utc(work)
            due_local = due_utc.astimezone(local_tz) if due_utc else None
            status = classify_status(due_utc, now_utc, local_tz)
            tasks.append(
                {
                    "course_id": course_id,
                    "course": course_name,
                    "coursework_id": work.get("id"),
                    "title": work.get("title", "Tarea sin título"),
                    "description": work.get("description", ""),
                    "type": work.get("workType", "ASSIGNMENT"),
                    "submission_state": (submission or {}).get("state", "NEW"),
                    "late": bool((submission or {}).get("late", status == "atrasada")),
                    "status": status,
                    "due_at_utc": due_utc.isoformat().replace("+00:00", "Z") if due_utc else None,
                    "due_at_local": due_local.isoformat() if due_local else None,
                    "link": work.get("alternateLink"),
                    "max_points": work.get("maxPoints"),
                }
            )

    status_priority = {"atrasada": 0, "vence_hoy": 1, "proxima": 2, "sin_fecha": 3}
    tasks.sort(
        key=lambda task: (
            status_priority.get(task["status"], 9),
            task["due_at_utc"] or "9999-12-31T23:59:59Z",
            task["course"].lower(),
            task["title"].lower(),
        )
    )

    return {
        "schema_version": 1,
        "generated_at_utc": now_utc.isoformat().replace("+00:00", "Z"),
        "generated_at_local": now_utc.astimezone(local_tz).isoformat(),
        "timezone": tz_name,
        "pending_count": len(tasks),
        "overdue_count": sum(1 for task in tasks if task["status"] == "atrasada"),
        "active_course_count": len(courses),
        "tasks": tasks,
        "course_errors": course_errors,
    }


def markdown_summary(payload: dict[str, Any]) -> str:
    lines = [
        "# Tareas pendientes de Google Classroom",
        "",
        f"Actualizado: **{payload['generated_at_local']}**",
        f"Pendientes: **{payload['pending_count']}** · Atrasadas: **{payload['overdue_count']}**",
        "",
    ]
    tasks = payload.get("tasks", [])
    if not tasks:
        lines.append("No hay tareas pendientes registradas.")
        return "\n".join(lines) + "\n"

    labels = {
        "atrasada": "🔴 Atrasada",
        "vence_hoy": "🟠 Vence hoy",
        "proxima": "🟢 Próxima",
        "sin_fecha": "⚪ Sin fecha",
    }
    for task in tasks:
        due = task.get("due_at_local") or "Sin fecha de entrega"
        title = task["title"].replace("\n", " ").strip()
        course = task["course"].replace("\n", " ").strip()
        lines.extend(
            [
                f"## {title}",
                f"- Materia: **{course}**",
                f"- Estado: **{labels.get(task['status'], task['status'])}**",
                f"- Entrega: `{due}`",
                f"- Estado en Classroom: `{task['submission_state']}`",
            ]
        )
        if task.get("link"):
            lines.append(f"- Enlace: {task['link']}")
        lines.append("")

    if payload.get("course_errors"):
        lines.extend(
            [
                "---",
                "Algunos cursos no pudieron consultarse. Revisa el archivo JSON para el diagnóstico.",
                "",
            ]
        )
    return "\n".join(lines)


def escape_drive_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def find_or_create_folder(drive: Any, folder_name: str) -> str:
    escaped = escape_drive_query(folder_name)
    response = (
        drive.files()
        .list(
            q=f"name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            spaces="drive",
            fields="files(id,name)",
            pageSize=10,
        )
        .execute()
    )
    files = response.get("files", [])
    if files:
        return files[0]["id"]
    folder = (
        drive.files()
        .create(
            body={"name": folder_name, "mimeType": "application/vnd.google-apps.folder"},
            fields="id",
        )
        .execute()
    )
    return folder["id"]


def upsert_drive_file(
    drive: Any,
    folder_id: str,
    file_name: str,
    content: str,
    mime_type: str,
) -> str:
    escaped = escape_drive_query(file_name)
    response = (
        drive.files()
        .list(
            q=f"name = '{escaped}' and '{folder_id}' in parents and trashed = false",
            spaces="drive",
            fields="files(id,name)",
            pageSize=10,
        )
        .execute()
    )
    media = MediaIoBaseUpload(
        io.BytesIO(content.encode("utf-8")),
        mimetype=mime_type,
        resumable=False,
    )
    files = response.get("files", [])
    if files:
        file_id = files[0]["id"]
        drive.files().update(fileId=file_id, media_body=media, fields="id").execute()
        return file_id

    created = (
        drive.files()
        .create(
            body={"name": file_name, "parents": [folder_id]},
            media_body=media,
            fields="id",
        )
        .execute()
    )
    return created["id"]


def sync() -> SyncResult:
    credentials = load_credentials()
    classroom = build("classroom", "v1", credentials=credentials, cache_discovery=False)
    drive = build("drive", "v3", credentials=credentials, cache_discovery=False)

    payload = collect_pending_tasks(classroom)
    folder_id = find_or_create_folder(drive, DRIVE_FOLDER_NAME)
    json_content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    md_content = markdown_summary(payload)

    json_file_id = upsert_drive_file(
        drive, folder_id, DRIVE_JSON_NAME, json_content, "application/json"
    )
    markdown_file_id = upsert_drive_file(
        drive, folder_id, DRIVE_MARKDOWN_NAME, md_content, "text/markdown"
    )
    return SyncResult(
        pending_count=payload["pending_count"],
        overdue_count=payload["overdue_count"],
        course_count=payload["active_course_count"],
        json_file_id=json_file_id,
        markdown_file_id=markdown_file_id,
    )


def main() -> int:
    try:
        result = sync()
    except Exception as exc:
        print(
            f"Classroom sync failed ({type(exc).__name__}). "
            "Revisa las APIs habilitadas, el secreto OAuth y su vigencia.",
            file=sys.stderr,
        )
        return 1

    print(
        "Classroom sync complete: "
        f"courses={result.course_count}, pending={result.pending_count}, overdue={result.overdue_count}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
