// Minimal Chrome extension API type declarations
declare namespace chrome {
  namespace runtime {
    const id: string | undefined;
    function getURL(path: string): string;
  }
}
