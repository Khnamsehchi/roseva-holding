const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return "";
  }
  return email;
}

export function compactPhone(value) {
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
    return "";
  }
  return compact;
}

function cleanLine(value, max) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateSubscribe(form) {
  const email = normalizeEmail(form.get("email"));
  if (!email) {
    const empty = typeof form.get("email") !== "string" || form.get("email").trim() === "";
    return {
      ok: false,
      fields: { email: empty ? "Enter your email address." : "Enter a valid email address." }
    };
  }
  return { ok: true, email };
}

export function validateContact(form) {
  const fields = {};
  const firstName = cleanLine(form.get("firstName"), 80);
  const lastName = cleanLine(form.get("lastName"), 80);
  const email = normalizeEmail(form.get("email"));
  const mobile = compactPhone(form.get("mobile"));
  const requestId = typeof form.get("requestId") === "string" ? form.get("requestId").trim() : "";
  if (!firstName) {
    fields.firstName = "Enter your first name.";
  }
  if (!lastName) {
    fields.lastName = "Enter your last name.";
  }
  if (!email) {
    const empty = typeof form.get("email") !== "string" || form.get("email").trim() === "";
    fields.email = empty ? "Enter your email address." : "Enter a valid email address.";
  }
  if (!mobile) {
    const empty = typeof form.get("mobile") !== "string" || form.get("mobile").trim() === "";
    fields.mobile = empty
      ? "Enter your mobile number, including the country code."
      : "Enter a mobile number with a country code, starting with +.";
  }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    fields.requestId = "The submission could not be matched. Please try again.";
  }
  let company = "";
  if (typeof form.get("company") === "string" && form.get("company").trim()) {
    company = cleanLine(form.get("company"), 120);
    if (!company) {
      fields.company = "Enter a shorter company name.";
    }
  }
  let message = "";
  if (typeof form.get("message") === "string" && form.get("message").trim()) {
    message = form.get("message").trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (message.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)) {
      fields.message = "Enter a message of 2000 characters or fewer.";
      message = "";
    }
  }
  if (Object.keys(fields).length) {
    return { ok: false, fields };
  }
  return { ok: true, firstName, lastName, email, mobile, company: company || "", message, requestId };
}
