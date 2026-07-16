{{- define "xrproxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "xrproxy.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "xrproxy.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "xrproxy.serviceName" -}}
{{- $prefixLength := sub 62 (len .id) -}}
{{- $prefix := include "xrproxy.fullname" .root | trunc (int $prefixLength) | trimSuffix "-" -}}
{{- printf "%s-%s" $prefix .id }}
{{- end }}

{{- define "xrproxy.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "xrproxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: xrproxy
{{- end }}

{{- define "xrproxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xrproxy.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .id }}
{{- end }}

{{- define "xrproxy.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "xrproxy.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "xrproxy.image" -}}
{{- $tag := default .root.Values.image.tag .service.image.tag -}}
{{- $repository := printf "%s/%s/%s" .root.Values.image.registry .root.Values.image.repositoryPrefix .service.image.repository -}}
{{- if .service.image.digest -}}
{{- printf "%s@%s" $repository .service.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end }}
