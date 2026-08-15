import { createSnapshotSource } from "./data-source.js";
import * as exposure from "./exposure.js";
import * as scenario from "./scenario.js";
import * as agent from "./agent.js";
import * as charts from "./charts.js";
import * as diagnose from "./diagnose.js";
import * as validate from "./validate.js";
import * as brief from "./brief.js";
import * as risk from "./risk.js";
import * as strategy from "./strategy.js";
import * as counter from "./counter.js";
import * as rag from "./rag.js";
import * as profile from "./profile.js";
import * as reasoner from "./reasoner.js";
import * as privacy from "./privacy.js";
import * as audit from "./audit.js";
import * as parseInput from "./parse-input.js";
import { createProvider, resolveMode } from "./llm-provider.js";
import { renderApp } from "./ui.js";

renderApp(document.getElementById("app"), {
  source: createSnapshotSource(),
  exposure, scenario, agent, charts, diagnose, validate, brief,
  risk, strategy, counter, rag, profile, reasoner, privacy, audit, parseInput,
  createProvider, resolveMode,
});
