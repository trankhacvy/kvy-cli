import Link from "next/link";

// TODO(art): replace this hotlinked placeholder with a generated local asset under
// /public before launch — a third-party image URL on an auth screen leaks visitor
// IP + Referer and can vanish at any time.
const AUTH_ART_URL =
  "https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=cinematic%20futuristic%20mission%20control%20workspace%2C%20encrypted%20agent%20operations%20dashboard%2C%20glowing%20glass%20panels%2C%20soft%20atmospheric%20lighting%2C%20sleek%20hardware%20desk%20setup%2C%20high-end%20product%20illustration%2C%20clean%20composition%2C%20premium%20editorial%20style&image_size=portrait_4_3";

/**
 * The full-height rounded art panel shared by every unprotected auth screen
 * (`/signin`, `/pair`, …) — one brand moment, one image, one visual language, so
 * a page a user is asked to approve something on (`/pair`) doesn't look like a
 * different, unbranded product from the one they signed in on. Hidden below `lg`;
 * `AuthBrandMark` covers mobile branding there instead.
 */
export function AuthArtPanel({ caption }: { caption: string }) {
  return (
    <aside className="relative hidden w-[55%] lg:block">
      <div className="absolute inset-0 overflow-hidden rounded-3xl border border-border/60 bg-muted">
        <img src={AUTH_ART_URL} alt="" className="size-full object-cover" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
        <Link
          href="/"
          aria-label="Falcon home"
          className="absolute top-5 left-5 flex items-center gap-2.5 rounded-full bg-black/40 px-3.5 py-2 text-white backdrop-blur-sm transition-colors hover:bg-black/55"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground text-xs">
            F
          </span>
          <span className="text-sm font-semibold tracking-tight">Falcon</span>
        </Link>
        <p className="absolute inset-x-0 bottom-6 text-center font-medium text-sm text-white/85">
          {caption}
        </p>
      </div>
    </aside>
  );
}
