/** Spotlight renderer entry. */
import { render } from "solid-js/web"
import App from "./App"
import "../panels/styles/tokens.css"
import "../panels/styles/app.css"
import "./spotlight.css"

const root = document.getElementById("root")
if (!root) throw new Error('Root element "#root" not found')
render(() => <App />, root)
