/** Require the full regional Secrets Manager ARN, including its generated suffix. */
export function exactNextEngineSecretArn(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^arn:aws:secretsmanager:us-west-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/.test(trimmed)
    ? trimmed : null;
}
