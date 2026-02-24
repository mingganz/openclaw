---
name: answer_faq
description: >
  Handle receptionist FAQ using the approved FAQ list only: business hours/open/close time, holiday hours, office address/location, phone support availability, after-hours voicemail, email, website, parking, language support, and company services. Use this for short factual info questions like "what are your hours?", "when are you open?", "where are you located?", or "what is your email?", and do not use it for booking, call routing, incidents, account/payment data, or human-judgment requests.

when_to_use: >
  Use this skill when the caller asks a general informational question
  that can be answered from a fixed FAQ list and does NOT require
  call routing, booking, account access, or human judgment.

do_not_use_when: >
  - Caller asks to speak to a person or department
  - Caller wants to book, cancel, or reschedule an appointment
  - Caller reports an outage or incident
  - Caller is upset, emotional, or makes legal threats
  - Caller provides or requests sensitive personal or payment information

inputs:
  type: object
  properties:
    question:
      type: string
      description: The caller's question in natural language
  required:
    - question

outputs:
  type: object
  properties:
    answer:
      type: string
      description: The spoken answer to the caller
    confidence:
      type: number
      description: Confidence score between 0 and 1
    source:
      type: string
      description: FAQ identifier used
    suggested_next_skill:
      type: string
      description: Optional next step if escalation is required
---

# Approved FAQ Knowledge Base

## FAQ-001 — Company Address

**Question examples**

- Where are you located?
- What’s your office address?
- What is your company address?

**Answer**
Our office is located at **123 Innovation Drive, Ottawa, Ontario, Canada**.

---

## FAQ-002 — Business Hours

**Question examples**

- What are your business hours?
- When are you open?
- What time do you close?

**Answer**
Our regular business hours are **Monday to Friday, 9:00 a.m. to 5:00 p.m. Eastern Time**, excluding public holidays.

---

## FAQ-003 — Holiday Hours

**Question examples**

- Are you open on holidays?
- Are you open on Christmas?
- Do you close on public holidays?

**Answer**
We are closed on major Canadian public holidays. Holiday hours may vary.

---

## FAQ-004 — Phone Support Availability

**Question examples**

- Do you offer phone support?
- Can I get help by phone?
- Is phone support available?

**Answer**
Yes, phone support is available during our regular business hours, Monday to Friday from 9:00 a.m. to 5:00 p.m. Eastern Time.

---

## FAQ-005 — After-Hours Contact

**Question examples**

- What if I call after hours?
- Can I leave a message?
- What happens if you’re closed?

**Answer**
If you call outside of business hours, you may leave a voicemail and our team will return your call on the next business day.

---

## FAQ-006 — Company Services

**Question examples**

- What does your company do?
- What services do you provide?
- Can you explain what you offer?

**Answer**
We provide cloud-based communication and phone system solutions for businesses, including enterprise VoIP and call management tools.

---

## FAQ-007 — Parking Information

**Question examples**

- Is there parking?
- Where can I park?
- Do you have visitor parking?

**Answer**
Yes, free visitor parking is available on-site at our office location.

---

## FAQ-008 — Email Contact

**Question examples**

- What’s your email address?
- How can I contact you by email?
- Who do I email for general inquiries?

**Answer**
For general inquiries, you can email us at **info@example.com**.

---

## FAQ-009 — Website Information

**Question examples**

- What’s your website?
- Where can I find more information online?
- Do you have a website?

**Answer**
You can find more information about our company at **www.example.com**.

---

## FAQ-010 — Language Support

**Question examples**

- Do you support French?
- Can I speak French?
- Is service available in French?

**Answer**
Yes, we provide service in both **English and French**.

---

# Response Rules

- Answer **only** using the FAQs above
- Do **not** invent or assume information
- If the question does not clearly match an FAQ:
  - Respond politely that further assistance is required
  - Set `suggested_next_skill` to `route_call` or `handoff_to_human`
- Keep responses short and suitable for spoken audio

# Example Output

```json
{
  "answer": "Our regular business hours are Monday to Friday, 9:00 a.m. to 5:00 p.m. Eastern Time, excluding public holidays.",
  "confidence": 0.95,
  "source": "FAQ-002",
  "suggested_next_skill": ""
}
```
