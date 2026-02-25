---
name: answer_faq
description: >
  Handle receptionist FAQ using the approved FAQ list only: business hours/open/close time, holiday hours, office address/location, phone support availability, after-hours voicemail, email, website, parking, language support, company services, FortiVoice product line details, and current promotions. Use this for short factual info questions like "what are your hours?", "where are you located?", "what is in your FortiVoice product line?", or "do you have any promotion?", and do not use it for booking, call routing, incidents, account/payment data, or human-judgment requests.

when_to_use: >
  Use this skill when the caller asks a general informational question
  that can be answered from a fixed FAQ list and does NOT require
  call routing, booking, account access, or human judgment, including
  product line overview and current promotion questions.

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
Our office is located at **326 moodie drive, Ottawa, Ontario, Canada**.

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
Live phone support is available Monday to Friday, from 9:00 a.m. to 5:00 p.m. Eastern Time.
AI-powered phone support is available 24 hours a day, 7 days a week.

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

## FAQ-011 — FortiVoice Product Line

**Question examples**

- What is included in the FortiVoice product line?
- What are FortiVoice products?
- What are FortiVoice product lines?
- What are FortiVoice product line offerings?
- What are FortiVoice product line?
- Can you tell me your FortiVoice lineup?

**Answer**
The FortiVoice product line includes **FortiVoice Cloud PBX subscription, on-prem PBX, physical phones, and mobile and desktop apps**.

---

## FAQ-012 — Promotions

**Question examples**

- Do you have any promotion for your product line?
- Do you have any promotions right now?
- Is there any current discount for FortiVoice?
- Are there any deals for FortiVoice Cloud PBX?
- Is FortiVoice Cloud service on sale?

**Answer**
Yes, we currently offer a **20% discount** on the **FortiVoice Cloud service**.

---

## FAQ-013 — Sales Department Email

**Question examples**

- What is your sales department email address?
- What is the sales email?
- How can I contact the sales department by email?
- Where can I email your sales team?

**Answer**
The sales department email address is **yucao@fortinet.com**.

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
