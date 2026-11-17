(function () {
  "use strict";

  /*
   * Forms call the Worker when /api/config reports that Turnstile is configured.
   * Nothing is written to localStorage, and form values are not logged.
   *   POST /api/subscribe
   *   POST /api/contact
   */
  var DESKTOP_QUERY = "(min-width: 860px)";
  var UNAVAILABLE = "Submissions are temporarily unavailable. Please try again later.";
  var RESULTS = {
    subscribed: "Thank you for subscribing! You\u2019re now subscribed to Roseva news and updates.",
    already_subscribed: "You\u2019re already subscribed to Roseva news and updates.",
    confirmation_required: "This address was unsubscribed. Check your email to confirm before it is subscribed again. It has not been reactivated.",
    received: "Thank you! Your message has been received. The relevant department will contact you within 24 hours."
  };

  var MESSAGES = {
    firstName: { missing: "Enter your first name." },
    lastName: { missing: "Enter your last name." },
    email: {
      missing: "Enter your email address.",
      invalid: "Enter a valid email address."
    },
    mobile: {
      missing: "Enter your mobile number, including the country code.",
      invalid: "Enter a mobile number with a country code, starting with +."
    }
  };

  var page = document.getElementById("page");
  var dialog = document.getElementById("preview-modal");
  var nav = document.getElementById("site-nav");
  var toggle = document.querySelector(".nav-toggle");
  var desktopQuery = window.matchMedia(DESKTOP_QUERY);
  var lastFocus = null;

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
  }

  function isPhone(value) {
    var compact = value.replace(/[\s().-]/g, "");
    return /^\+[1-9]\d{7,14}$/.test(compact);
  }

  function errorElementFor(input) {
    var describedBy = input.getAttribute("aria-describedby") || "";
    var ids = describedBy.split(/\s+/);
    var index = 0;
    for (index = 0; index < ids.length; index += 1) {
      var element = document.getElementById(ids[index]);
      if (element && element.classList.contains("field-error")) {
        return element;
      }
    }
    return null;
  }

  function setFieldError(input, message) {
    var error = errorElementFor(input);
    if (message) {
      input.setAttribute("aria-invalid", "true");
      if (error) {
        error.textContent = message;
      }
    } else {
      input.removeAttribute("aria-invalid");
      if (error) {
        error.textContent = "";
      }
    }
  }

  function messageFor(field) {
    var copy = MESSAGES[field.name];
    var value = field.value.trim();
    if (!copy) {
      return "";
    }
    if (field.required && value === "") {
      return copy.missing;
    }
    if (field.type === "email" && value !== "" && !isEmail(value)) {
      return copy.invalid;
    }
    if (field.name === "mobile" && value !== "" && !isPhone(value)) {
      return copy.invalid;
    }
    return "";
  }

  function setFormStatus(form, message) {
    var status = form.querySelector(".form-status");
    if (!status) {
      return;
    }
    status.textContent = message || "";
    if (message) {
      status.setAttribute("role", "alert");
    } else {
      status.removeAttribute("role");
    }
  }

  function validateForm(form) {
    var fields = form.querySelectorAll("input, textarea");
    var firstInvalid = null;
    var index = 0;
    form.dataset.submitted = "true";

    for (index = 0; index < fields.length; index += 1) {
      var message = messageFor(fields[index]);
      setFieldError(fields[index], message);
      if (message && !firstInvalid) {
        firstInvalid = fields[index];
      }
    }

    if (firstInvalid) {
      setFormStatus(form, "Check the highlighted fields. Nothing was sent or saved.");
      firstInvalid.focus();
      return false;
    }
    if (form.dataset.submissionsEnabled !== "true") {
      setFormStatus(form, UNAVAILABLE);
      return false;
    }
    if (!turnstileToken(form)) {
      setFormStatus(form, "Complete the verification check before submitting.");
      return false;
    }

    setFormStatus(form, "");
    return true;
  }

  function turnstileToken(form) {
    var slot = form.querySelector("[data-turnstile-slot]");
    var input = slot ? slot.querySelector("[name='cf-turnstile-response']") : null;
    return input ? input.value.trim() : "";
  }

  function resetTurnstile(form) {
    if (window.turnstile && form.dataset.turnstileId) {
      window.turnstile.reset(form.dataset.turnstileId);
    }
  }

  function setBusy(form, busy) {
    var button = form.querySelector("[type='submit']");
    if (!button) {
      return;
    }
    if (busy) {
      if (!button.dataset.label) {
        button.dataset.label = button.textContent;
      }
      button.textContent = "Please wait\u2026";
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      return;
    }
    if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
    button.disabled = form.dataset.submissionsEnabled !== "true";
    button.removeAttribute("aria-busy");
  }

  function applyServerFields(form, fields) {
    var first = null;
    var name = "";
    if (!fields) {
      return;
    }
    for (name in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, name)) {
        continue;
      }
      var input = form.querySelector("[name='" + CSS.escape(name) + "']");
      if (!input || !input.matches("input, textarea")) {
        continue;
      }
      setFieldError(input, fields[name]);
      if (!first) {
        first = input;
      }
    }
    if (first) {
      first.focus();
    }
  }

  function clearFieldErrors(form) {
    Array.prototype.forEach.call(form.querySelectorAll("input, textarea"), function (input) {
      setFieldError(input, "");
    });
  }

  function resetForm(form) {
    form.reset();
    form.dataset.submitted = "";
    var requestId = form.querySelector("[name='requestId']");
    if (requestId) {
      requestId.value = "";
    }
    clearFieldErrors(form);
    setFormStatus(form, "");
    resetTurnstile(form);
  }

  function ensureRequestId(form) {
    var input = form.querySelector("[name='requestId']");
    if (!input) {
      return;
    }
    if (!input.value) {
      input.value = crypto.randomUUID();
    }
  }

  function postForm(endpoint, form) {
    return fetch(endpoint, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" }
    }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  function submitForm(form) {
    var endpoint = form.getAttribute("data-endpoint");
    var button = form.querySelector("[type='submit']");
    if (!validateForm(form) || !endpoint) {
      return;
    }
    ensureRequestId(form);
    setBusy(form, true);
    postForm(endpoint, form).then(function (result) {
      var data = result.data || {};
      if (result.ok && RESULTS[data.result]) {
        var restore = button;
        var copy = RESULTS[data.result];
        var splitAt = copy.indexOf("! ");
        var noticeTitle = splitAt === -1 ? copy : copy.slice(0, splitAt + 1);
        var noticeText = splitAt === -1 ? "" : copy.slice(splitAt + 2);
        if (data.result === "subscribed" || data.result === "already_subscribed" || data.result === "received") {
          resetForm(form);
        }
        openNotice(noticeTitle, noticeText, "Roseva", restore);
        return;
      }
      form.dataset.submitted = "true";
      applyServerFields(form, data.fields);
      setFormStatus(form, typeof data.error === "string" && data.error.length < 240 ? data.error : "The request did not go through. Your information was not confirmed as sent or saved.");
      resetTurnstile(form);
    }).catch(function () {
      setFormStatus(form, "The request did not go through. Your information was not confirmed as sent or saved.");
      resetTurnstile(form);
    }).then(function () {
      setBusy(form, false);
    });
  }

  function loadTurnstile(siteKey) {
    return new Promise(function (resolve, reject) {
      if (window.turnstile) {
        resolve();
        return;
      }
      var script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error("verification unavailable"));
      };
      document.head.appendChild(script);
      script.dataset.siteKey = siteKey;
    });
  }

  function enableForm(form, siteKey) {
    var slot = form.querySelector("[data-turnstile-slot]");
    var notice = form.querySelector("[id$='preview-note']");
    var button = form.querySelector("[type='submit']");
    if (slot && window.turnstile) {
      form.dataset.turnstileId = String(window.turnstile.render(slot, {
        sitekey: siteKey,
        action: form.getAttribute("data-turnstile-action") || "submit",
        theme: "dark"
      }));
    }
    form.dataset.submissionsEnabled = "true";
    if (notice) {
      notice.hidden = true;
      notice.textContent = "";
    }
    if (button) {
      button.disabled = false;
    }
  }

  function configureForms() {
    fetch("/api/config", { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json();
      })
      .then(function (config) {
        if (!config || config.submissionsEnabled !== true || !config.turnstileSiteKey) {
          return;
        }
        return loadTurnstile(config.turnstileSiteKey).then(function () {
          Array.prototype.forEach.call(document.querySelectorAll("form[data-endpoint]"), function (form) {
            enableForm(form, config.turnstileSiteKey);
          });
        });
      })
      .catch(function () {
        return null;
      });
  }

  function getFocusable(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      function (element) {
        return !element.disabled && element.getAttribute("aria-hidden") !== "true";
      }
    );
  }

  function openNotice(title, text, eyebrow, restoreFocus) {
    var titleNode = document.getElementById("preview-modal-title");
    var textNode = document.getElementById("preview-modal-text");
    var eyebrowNode = document.getElementById("notice-eyebrow");
    if (titleNode) {
      titleNode.textContent = title || "";
    }
    if (textNode) {
      textNode.textContent = text || "";
    }
    if (eyebrowNode) {
      eyebrowNode.textContent = eyebrow || "Roseva";
    }
    if (!dialog || typeof dialog.showModal !== "function" || dialog.open) {
      return;
    }
    lastFocus = restoreFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog.showModal();
    if (page) {
      page.inert = true;
    }
    var closeButton = dialog.querySelector("[data-close-modal]");
    if (closeButton) {
      closeButton.focus();
    }
  }

  function closePreviewModal() {
    if (dialog && dialog.open) {
      dialog.close();
    }
  }

  function restoreFocus() {
    if (page) {
      page.inert = false;
    }
    if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  function setMenuOpen(open) {
    if (!nav || !toggle) {
      return;
    }
    var isOpen = Boolean(open) && !desktopQuery.matches;
    var label = toggle.querySelector(".nav-toggle__label");
    nav.classList.toggle("is-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
    if (label) {
      label.textContent = isOpen ? "Close" : "Menu";
    }
    if (desktopQuery.matches) {
      nav.removeAttribute("aria-hidden");
    } else {
      nav.setAttribute("aria-hidden", String(!isOpen));
    }
  }

  function currentSectionId() {
    var sections = document.querySelectorAll("main section[id]");
    var current = "";
    var offset = 140;
    var index = 0;
    for (index = 0; index < sections.length; index += 1) {
      var rect = sections[index].getBoundingClientRect();
      if (rect.top - offset <= 0) {
        current = sections[index].id;
      }
    }
    return current;
  }

  function updateCurrentNav() {
    if (!nav) {
      return;
    }
    var current = currentSectionId();
    var links = nav.querySelectorAll("a[href^='#']");
    var index = 0;
    for (index = 0; index < links.length; index += 1) {
      var id = links[index].getAttribute("href").slice(1);
      if (id === current) {
        links[index].setAttribute("aria-current", "true");
      } else {
        links[index].removeAttribute("aria-current");
      }
    }
  }

  if (toggle && nav) {
    setMenuOpen(false);
    toggle.addEventListener("click", function () {
      setMenuOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    desktopQuery.addEventListener("change", function () {
      setMenuOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") {
        return;
      }
      if (dialog && (dialog.open || dialog.contains(event.target))) {
        return;
      }
      if (toggle.getAttribute("aria-expanded") === "true") {
        setMenuOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("click", function (event) {
      if (!desktopQuery.matches && toggle.getAttribute("aria-expanded") === "true") {
        if (!nav.contains(event.target) && !toggle.contains(event.target)) {
          setMenuOpen(false);
        }
      }
    });
    window.addEventListener("scroll", updateCurrentNav, { passive: true });
    updateCurrentNav();
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("a[href^='#']");
    var id = "";
    var target = null;
    if (!link) {
      return;
    }
    id = link.getAttribute("href").slice(1);
    target = document.getElementById(id);
    if (!target) {
      return;
    }
    setMenuOpen(false);
    if (target.hasAttribute("data-focus-target")) {
      window.requestAnimationFrame(function () {
        target.focus({ preventScroll: true, focusVisible: true });
      });
    }
  });

  configureForms();

  Array.prototype.forEach.call(document.querySelectorAll("form[data-endpoint]"), function (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitForm(form);
    });
    form.addEventListener("input", function (event) {
      if (form.dataset.submitted !== "true" || !event.target || !event.target.matches("input, textarea")) {
        return;
      }
      setFieldError(event.target, messageFor(event.target));
      if (!form.querySelector("[aria-invalid='true']")) {
        setFormStatus(form, "");
      }
    });
  });

  if (dialog) {
    dialog.addEventListener("close", restoreFocus);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) {
        closePreviewModal();
      }
    });
    dialog.addEventListener("keydown", function (event) {
      var focusable = [];
      var first = null;
      var last = null;
      if (event.key === "Escape" && dialog.open) {
        event.preventDefault();
        closePreviewModal();
        return;
      }
      if (event.key !== "Tab" || !dialog.open) {
        return;
      }
      focusable = getFocusable(dialog);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      first = focusable[0];
      last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    var closeButton = dialog.querySelector("[data-close-modal]");
    if (closeButton) {
      closeButton.addEventListener("click", closePreviewModal);
    }
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && dialog.open) {
        event.preventDefault();
        closePreviewModal();
      }
    });
  }
})();
