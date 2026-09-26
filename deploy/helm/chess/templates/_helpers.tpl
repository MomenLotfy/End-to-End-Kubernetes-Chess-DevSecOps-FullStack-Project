{{/*
Standard labels for every chess object.
*/}}
{{- define "chess.labels" -}}
app.kubernetes.io/name: chess
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: argocd
chess/environment: {{ .Values.global.environment }}
{{- end }}

{{/*
Component labels (adds the component selector label).
Expects dict: { ctx, component }
*/}}
{{- define "chess.componentLabels" -}}
{{ include "chess.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Selector labels (stable across releases; safe for selectors).
Expects dict: { ctx, component }
*/}}
{{- define "chess.selectorLabels" -}}
app.kubernetes.io/name: chess
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Digest-pinned image reference. FAILS CLOSED on missing/weak identity:
- registry must be set (GitOps values)
- digest must match ^sha256:[0-9a-f]{64}$ (no tags, no latest, no main)
Expects dict: { registry, repository, digest, context }
*/}}
{{- define "chess.image" -}}
{{- $registry := required (printf "%s: global.registry is required (GitOps values provide the ECR registry host)" .context) .registry -}}
{{- $digest := required (printf "%s: image.digest is required (immutable Wave 3 release digest; tags are forbidden)" .context) .digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail (printf "%s: image.digest must be a full sha256 digest (got %q)" .context $digest) -}}
{{- end -}}
{{ printf "%s/%s@%s" $registry .repository $digest }}
{{- end }}

{{/*
Backend replica invariant guard (ADR-002 / Wave 7): there is no replica knob;
if anyone adds backend.replicaCount with a value other than 1, fail loudly.
*/}}
{{- define "chess.backendReplicaGuard" -}}
{{- $r := int (.Values.backend.replicaCount | default 1) -}}
{{- if ne $r 1 -}}
{{- fail "ARCHITECTURE INVARIANT VIOLATED: backend replicas must be exactly 1 (process-local Socket.io/rate-limit state; scale-out is Wave 7, ADR-002). Remove backend.replicaCount." -}}
{{- end -}}
{{- end }}
