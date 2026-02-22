declare module "screenshot-desktop" {
  interface DisplayInfo {
    id: string | number;
    name?: string;
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    width?: number;
    height?: number;
  }

  interface ScreenshotOptions {
    format?: "png" | "jpg";
    screen?: string | number;
    filename?: string;
  }

  interface ScreenshotApi {
    (options?: ScreenshotOptions): Promise<Buffer>;
    listDisplays(): Promise<DisplayInfo[]>;
  }

  const screenshot: ScreenshotApi;

  export default screenshot;
}
