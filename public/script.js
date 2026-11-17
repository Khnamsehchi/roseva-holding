(function () {
  "use strict";

  /*
   * Preview only: valid forms do not call the network, and nothing is
   * written to localStorage or the console.
   * Set PREVIEW_ONLY to false once these endpoints exist:
   *   POST /api/subscribe
   *   POST /api/contact
   */
  var PREVIEW_ONLY = true;
  var DESKTOP_QUERY = "(min-width: 860px)";

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

    setFormStatus(form, "");
    return true;
  }

  function postForm(endpoint, form) {
    return fetch(endpoint, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" }
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Request was not accepted");
      }
      return response;
    });
  }

  function submitForm(form) {
    var endpoint = form.getAttribute("data-endpoint");
    var button = form.querySelector("[type='submit']");
    if (!validateForm(form)) {
      return;
    }
    if (PREVIEW_ONLY || !endpoint) {
      openPreviewModal();
      return;
    }
    if (button) {
      button.disabled = true;
    }
    postForm(endpoint, form).then(function () {
      setFormStatus(form, "The server accepted the request. This page does not confirm that an email was delivered.");
    }).catch(function () {
      setFormStatus(form, "The request did not go through. Your information was not confirmed as sent or saved.");
    }).then(function () {
      if (button) {
        button.disabled = false;
      }
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

  function openPreviewModal() {
    if (!dialog || dialog.open) {
      return;
    }
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
