/**
 * Return a self-contained HTML page that loads the Scalar API reference UI
 * from CDN and points it at the given OpenAPI spec URL.
 */
export function getScalarHtml(specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Band API Docs</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '${specUrl}',
      theme: 'default',
    })
  </script>
</body>
</html>`;
}
