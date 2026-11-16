export const BATCH_EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ref: { type: "string" },
    title: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    startTime: { type: ["string", "null"] },
    endTime: { type: ["string", "null"] },
    timeZone: { type: "string" },
    location: { type: ["string", "null"] },
    recurrence: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            frequency: { type: "string", enum: ["weekly"] },
            weekdays: {
              type: "array",
              items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
            },
            until: { anyOf: [{ type: "string" }, { type: "null" }] },
            count: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
          required: ["frequency", "weekdays", "until", "count"],
        },
      ],
    },
    notificationAction: {
      type: "string",
      enum: ["preserve", "replace", "add", "remove", "default"],
    },
    notificationOverrides: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: "string", enum: ["popup", "email"] },
          minutes: { type: "integer", minimum: 0, maximum: 40320 },
        },
        required: ["method", "minutes"],
      },
    },
    needsClarification: { type: "boolean" },
    clarificationQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "ref",
    "title",
    "date",
    "startTime",
    "endTime",
    "timeZone",
    "location",
    "recurrence",
    "notificationAction",
    "notificationOverrides",
    "needsClarification",
    "clarificationQuestions",
  ],
};

export const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["batch"] },
    tooMany: { type: "boolean" },
    message: { type: ["string", "null"] },
    events: {
      type: "array",
      maxItems: 11,
      items: BATCH_EVENT_SCHEMA,
    },
  },
  required: ["kind", "tooMany", "message", "events"],
};

export const BATCH_FOLLOWUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["batch-followup"] },
    action: { type: "string", enum: ["update", "skip", "ambiguous", "none"] },
    ref: { type: ["string", "null"] },
    question: { type: ["string", "null"] },
    event: { anyOf: [{ type: "null" }, BATCH_EVENT_SCHEMA] },
  },
  required: ["kind", "action", "ref", "question", "event"],
};
