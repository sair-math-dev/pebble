const port = Number(process.env.PORT || 3000);
try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
