/**
 * Generic iframe panel for EXTERNAL plugins. The console renders one of these
 * for every runtime-registered capability that advertises a `panel.url`, so a
 * plugin's UI appears in the rail with ZERO bundled code — it serves its own
 * page (any framework), fully CSS-isolated in the iframe.
 *
 * The plugin page is handed two query params so it can talk back:
 *   ?host=<daemon base>   — call the host: its own proxied routes (/cap/<id>/…),
 *                           the native bridge (/cap/notify/test), or /config.
 *   &cap=<id>             — its own capability id.
 */
import type { JSX } from "solid-js"
import { api } from "../../bridge"
import "./external.css"

export type ExternalPanelDef = {
  id: string
  title: string
  /** Absolute URL the plugin serves its UI at (its own origin). */
  url: string
}

export function IframePanel(props: ExternalPanelDef): JSX.Element {
  const src = (): string => {
    let u: URL
    try {
      u = new URL(props.url, api.baseUrl)
    } catch {
      return props.url
    }
    u.searchParams.set("host", api.baseUrl)
    u.searchParams.set("cap", props.id)
    return u.toString()
  }
  return (
    <div class="ext-panel">
      {/* Sandboxed: the plugin runs on its own (loopback) origin and keeps
          allow-same-origin so its own fetch/storage work, but is blocked from
          top-level navigation and other ambient capabilities. apiBaseUrl/panel.url
          are loopback-validated host-side, so this can't load a remote page. */}
      <iframe
        class="ext-frame"
        src={src()}
        title={props.title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  )
}
