---
name: book-appointment
description: Collect booking parameters across turns, execute a calendar booking command, and confirm results.
metadata: { "openclaw": { "emoji": "📅" } }
---

# Book Appointment

Use this skill when the user wants to schedule or book an appointment.

Goal: collect required fields, validate them, execute one booking command, then send a clear confirmation.

## Required Fields

- `customer_id` (string)
- `appointment_date` (ISO date `YYYY-MM-DD`)
- `appointment_time` (24h `HH:MM`)
- `timezone` (IANA zone, for example `America/Los_Angeles`)

Optional fields:

- `service` (string)
- `duration_minutes` (integer)
- `notes` (string)

## Workflow (Mandatory)

1. Detect booking intent.
2. Collect missing required fields via follow-up questions.
3. Validate all required fields.
4. Summarize details and ask for final confirmation.
5. Only after explicit confirmation (`yes`, `confirm`, `book it`, `go ahead`), execute booking command.
6. Parse command JSON output.
7. Reply with success confirmation or actionable failure.

## Parameter Collection Rules

- Ask only for missing fields.
- Ask one focused question at a time unless user requests a full form.
- If user gives natural date/time (for example, "next Tuesday at 3pm"), convert to explicit `appointment_date` + `appointment_time` and confirm interpretation before execution.
- If timezone is missing, ask for it explicitly. Do not assume.
- Never execute the booking command with missing required fields.

## Validation Rules

- `appointment_date` must match `^\d{4}-\d{2}-\d{2}$`.
- `appointment_time` must match `^\d{2}:\d{2}$`.
- `duration_minutes` must be a positive integer if provided.
- If any field is invalid, explain what is wrong and ask for correction.

## Execution Contract

Use one executable command that accepts JSON input and returns JSON output.

Replace `calendar-book` below with your real command if different.

```bash
calendar-book \
  --input-json '{
    "customerId": "C12345",
    "date": "2026-02-20",
    "time": "15:30",
    "timezone": "America/Los_Angeles",
    "service": "consultation",
    "durationMinutes": 30,
    "notes": "prefers phone call"
  }'
```

Expected JSON success shape:

```json
{
  "ok": true,
  "appointmentId": "APT-12345",
  "startAt": "2026-02-20T15:30:00-08:00",
  "timezone": "America/Los_Angeles"
}
```

Expected JSON error shape:

```json
{
  "ok": false,
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "Requested time is no longer available."
  }
}
```

## Confirmation Reply Rules

On success:

- Confirm booked date/time with timezone.
- Include `appointmentId`.
- Ask if user wants any changes.

On failure:

- State failure reason clearly.
- If recoverable (for example slot unavailable), ask for alternate date/time.
- Do not pretend booking succeeded.

## Safety

- Never claim a booking exists unless command returned `ok: true`.
- Never fabricate `appointmentId`.
- Never run booking command before explicit user confirmation.
