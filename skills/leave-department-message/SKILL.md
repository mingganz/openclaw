---
name: leave_department_message
description: >
  Collect a caller message for Sales or Service, confirm details, and send it to
  the mapped department email only. Use this for "leave a message" or callback
  requests that do not require immediate live transfer.
metadata: { "openclaw": { "emoji": "📝" } }
when_to_use: >
  Use this skill when a caller asks to leave a message for Sales or Service
  and provides routine business information.

do_not_use_when: >
  - Caller asks for immediate live transfer
  - Caller reports emergency, outage, or incident response needs
  - Caller makes legal threats or is highly escalated
  - Caller requests account/payment actions requiring secure identity checks

inputs:
  type: object
  properties:
    request:
      type: string
      description: Caller request in natural language
  required:
    - request

outputs:
  type: object
  properties:
    answer:
      type: string
      description: Final spoken response to the caller
    department:
      type: string
      description: sales or service
    to_email:
      type: string
      description: Destination email resolved from department mapping
    status:
      type: string
      description: collected, sent, or failed
    suggested_next_skill:
      type: string
      description: Optional escalation skill when send fails or caller needs live help
---

# Leave Department Message

## Goal

Capture a caller message and deliver it to the correct department inbox.

## Department Routing (Fixed)

- `sales` -> `yucao@fortinet.com`
- `service` -> `yucao.ca@gmail.com`

Do not route to any other address in this skill.

## Intent Examples

- "I want to leave a message for sales."
- "Can you ask service to call me back?"
- "Please leave this message for your service team."
- "I need sales to contact me."

## Required Fields

- `department` (`sales` or `service`)
- `caller_name`
- `message`
- At least one contact method: `phone` or `email`

## Optional Fields

- `company`
- `preferred_callback_time`

## Workflow (Mandatory)

1. Detect message-taking intent.
2. Resolve `department`; if unclear, ask "Should I send this to Sales or Service?"
3. Collect missing required fields one at a time.
4. Read back a short summary and ask for explicit confirmation.
5. Only after confirmation, send one email to the mapped department.
6. Return a short spoken confirmation to the caller.

## Validation Rules

- Department must be exactly `sales` or `service`.
- If caller gives both phone and email, keep both.
- If caller gives no contact method, ask for at least one.
- Keep the message concise but do not alter meaning.

## Email Sending Contract

Use `himalaya` if configured.

Subject format:

`[OpenClaw Caller Message][<Department>] <caller_name>`

Body template:

- Department
- Caller name
- Phone
- Email
- Company
- Preferred callback time
- Message

Example send:

```bash
cat << 'EOF' | himalaya template send
To: yucao@fortinet.com
Subject: [OpenClaw Caller Message][Sales] Alex Chen

Department: Sales
Caller name: Alex Chen
Phone: +1-613-555-0100
Email: alex@example.com
Company: Example Corp
Preferred callback time: Tomorrow afternoon
Message: Please send pricing for 30 users and setup timeline.
EOF
```

If email tooling is unavailable or sending fails, set `status` to `failed`, apologize briefly, and set `suggested_next_skill` to `handoff_to_human`.

## Output Rules

- Keep spoken responses concise and natural for voice calls.
- Never claim the message was sent unless the send command succeeds.
- Never reveal internal errors to callers; provide a polite fallback.

## Example Output

```json
{
  "answer": "Thanks, I have sent your message to our sales team. They will follow up using the contact details you provided.",
  "department": "sales",
  "to_email": "yucao@fortinet.com",
  "status": "sent",
  "suggested_next_skill": ""
}
```
