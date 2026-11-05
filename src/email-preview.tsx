import React, { useState } from "react";
export function EmailPreview({ gid, iid }: { gid: string; iid: string }) {
  const [open, setOpen] = useState(false),
    [version, setVersion] = useState(0);
  const url = "/api/groups/" + gid + "/issues/" + iid + "/email-preview";
  return (
    <section className="panel">
      <h2 className="panel-title">Newsletter preview</h2>
      <p className="small">
        Before publication this preview includes only your saved draft; submit
        it to include your changes. Photos in delivered emails can be saved or
        forwarded.
      </p>
      <div className="row">
        <button
          type="button"
          className="button secondary"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide email preview" : "Preview newsletter email"}
        </button>
        {open && (
          <button
            type="button"
            className="quiet"
            onClick={() => setVersion(version + 1)}
          >
            Refresh preview
          </button>
        )}
      </div>
      {open && (
        <>
          <p className="small">
            Large letters include as many images as email limits allow;
            remaining photos link to the private web letter.
          </p>
          <iframe
            key={version}
            title="Newsletter email preview"
            className="email-frame"
            sandbox="allow-same-origin"
            src={url}
          />
          <a className="download" href={url} target="_blank" rel="noreferrer">
            Open full preview
          </a>
        </>
      )}
    </section>
  );
}
