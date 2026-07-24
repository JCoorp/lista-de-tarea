from datetime import datetime, timezone

from classroom_bridge import classify_status, due_datetime_utc, submission_is_pending


def test_due_datetime_uses_utc():
    work = {
        "dueDate": {"year": 2026, "month": 7, "day": 24},
        "dueTime": {"hours": 22, "minutes": 30},
    }
    assert due_datetime_utc(work) == datetime(2026, 7, 24, 22, 30, tzinfo=timezone.utc)


def test_completed_submissions_are_not_pending():
    assert not submission_is_pending({"state": "TURNED_IN"})
    assert not submission_is_pending({"state": "RETURNED"})


def test_unsubmitted_and_reclaimed_are_pending():
    assert submission_is_pending(None)
    assert submission_is_pending({"state": "NEW"})
    assert submission_is_pending({"state": "RECLAIMED_BY_STUDENT"})


def test_status_classification():
    now = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)
    assert classify_status(None, now) == "sin_fecha"
    assert classify_status(datetime(2026, 7, 24, 10, 0, tzinfo=timezone.utc), now) == "atrasada"
    assert classify_status(datetime(2026, 7, 24, 18, 0, tzinfo=timezone.utc), now) == "vence_hoy"
    assert classify_status(datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc), now) == "proxima"
