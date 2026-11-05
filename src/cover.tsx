import React, { useEffect, useRef, useState } from "react";
import { api, uploadCover } from "./api";
import { Button, ErrorMessage } from "./ui";
import type { Group } from "../shared/contracts";
export function CoverEditor({
  group,
  reload,
}: {
  group: Group;
  reload: () => Promise<unknown>;
}) {
  const [image, setImage] = useState<ImageBitmap | null>(null),
    [zoom, setZoom] = useState(1),
    [x, setX] = useState(0),
    [y, setY] = useState(0),
    [caption, setCaption] = useState(group.cover_caption || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => () => image?.close(), [image]);
  useEffect(() => {
    if (!image || !canvas.current) return;
    const c = canvas.current,
      ctx = c.getContext("2d")!;
    const scale =
      Math.max(c.width / image.width, c.height / image.height) * zoom;
    const w = image.width * scale,
      h = image.height * scale;
    ctx.fillStyle = "#fffefd";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(
      image,
      ((c.width - w) * (x + 1)) / 2,
      ((c.height - h) * (y + 1)) / 2,
      w,
      h,
    );
  }, [image, zoom, x, y]);
  async function choose(file: File) {
    try {
      setError("");
      if (
        file.size > 20 * 1048576 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw new Error("Choose a JPEG, PNG or WebP smaller than 20 MB.");
      const next = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      setImage(next);
      setZoom(1);
      setX(0);
      setY(0);
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (!canvas.current) throw new Error("Choose a cover first.");
      let blob: Blob | null = null;
      for (const quality of [0.85, 0.7, 0.5, 0.35, 0.2]) {
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.current!.toBlob(resolve, "image/jpeg", quality),
        );
        if (blob && blob.size <= 196608) break;
      }
      if (!blob || blob.size > 196608)
        throw new Error("Try a simpler or smaller cover photo.");
      await uploadCover("/groups/" + group.id + "/cover", blob, caption);
      setImage(null);
      await reload();
      setMessage("Cover saved. It will appear in your next letter.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2 className="panel-title">Your group cover</h2>
      <p className="small">
        Choose a wide group photo for the home card, web letter and newsletter
        email. Replacement affects future letters; previously delivered copies
        stay unchanged.
      </p>
      <ErrorMessage error={error} />
      {message && <p role="status">{message}</p>}
      {group.cover_id && !image && (
        <figure>
          <img
            className="group-cover"
            src={"/api/groups/" + group.id + "/covers/" + group.cover_id}
            alt={group.cover_caption || group.name + " cover"}
          />
          {group.cover_caption && (
            <figcaption>{group.cover_caption}</figcaption>
          )}
        </figure>
      )}
      <label>
        Choose a group cover
        <input
          aria-label="Choose a group cover"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void choose(file);
          }}
        />
      </label>
      {image && (
        <>
          <canvas
            aria-label="Cover crop preview"
            className="cover-canvas"
            width={1200}
            height={600}
            ref={canvas}
          />
          <label>
            Zoom
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(+e.target.value)}
            />
          </label>
          <label>
            Horizontal crop position
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={x}
              onChange={(e) => setX(+e.target.value)}
            />
          </label>
          <label>
            Vertical crop position
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={y}
              onChange={(e) => setY(+e.target.value)}
            />
          </label>
          <label>
            Cover description
            <input
              maxLength={250}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
          <div className="stack">
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? "Saving cover…" : "Save group cover"}
            </Button>
            <Button secondary disabled={busy} onClick={() => setImage(null)}>
              Cancel crop
            </Button>
          </div>
        </>
      )}
      {group.cover_id && !image && (
        <Button
          secondary
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const r = await fetch(
                "/api/groups/" + group.id + "/covers/" + group.cover_id,
                { credentials: "same-origin" },
              );
              if (!r.ok) throw new Error("Cover could not be loaded.");
              setImage(await createImageBitmap(await r.blob()));
              setCaption(group.cover_caption || "");
              setZoom(1);
              setX(0);
              setY(0);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Edit current cover
        </Button>
      )}
      {group.cover_id && !image && (
        <Button
          secondary
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/groups/" + group.id + "/cover", { method: "DELETE" });
              await reload();
              setMessage("Current cover removed.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Remove current cover
        </Button>
      )}
    </section>
  );
}
