// Band desktop native helpers (macOS only): the window toolbar style and SF Symbol rendering.
// Loaded optionally: when it is missing or fails, the window keeps its plain title bar and a mod
// keeps its own icons. N-API, so it does not depend on the Electron version.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <napi.h>

namespace {
void onMain(void (^block)(void)) {
  if ([NSThread isMainThread]) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

// Electron hands out the window's content view (an NSView pointer in the buffer).
NSView *contentViewOf(const Napi::Value &value) {
  if (!value.IsBuffer()) return nil;
  auto buf = value.As<Napi::Buffer<unsigned char>>();
  if (buf.Length() < sizeof(void *)) return nil;
  void *p = *reinterpret_cast<void **>(buf.Data());
  return (__bridge NSView *)p;
}
}  // namespace

// setWindowToolbar(handle, style) with style 1 expanded, 3 unified, 4 unified compact. An empty
// toolbar gives the window the large corner radius of a native toolbar window. The content keeps
// running under the title bar (full size content view). Returns the window's frame height.
Napi::Value SetWindowToolbar(const Napi::CallbackInfo &info) {
  NSView *root = contentViewOf(info[0]);
  int style = info[1].ToNumber().Int32Value();
  if (!root) return info.Env().Undefined();
  onMain(^{
    NSWindow *window = root.window;
    if (!window) return;
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"app.band.window"];
    toolbar.showsBaselineSeparator = NO;
    window.toolbar = toolbar;
    window.toolbarStyle = (NSWindowToolbarStyle)style;
    window.titlebarAppearsTransparent = YES;
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  });
  return info.Env().Undefined();
}

// symbolPNG(name, pointSize, weight, scale) -> PNG bytes of the SF Symbol (black, transparent), or null.
// weight is an NSFontWeight, -0.8 ultra light to 0 regular to 0.4 bold.
Napi::Value SymbolPNG(const Napi::CallbackInfo &info) {
  std::string name = info[0].ToString().Utf8Value();
  double pt = info[1].ToNumber().DoubleValue();
  double weight = info[2].ToNumber().DoubleValue();
  double scale = info.Length() > 3 ? info[3].ToNumber().DoubleValue() : 4;
  if (pt < 4 || pt > 128 || scale < 1 || scale > 8) return info.Env().Null();
  __block NSData *png = nil;
  onMain(^{
    NSImage *img = [NSImage imageWithSystemSymbolName:[NSString stringWithUTF8String:name.c_str()]
                             accessibilityDescription:nil];
    if (!img) return;
    NSImageSymbolConfiguration *cfg = [NSImageSymbolConfiguration configurationWithPointSize:pt
                                                                                      weight:weight
                                                                                       scale:NSImageSymbolScaleMedium];
    img = [img imageWithSymbolConfiguration:cfg];
    NSSize s = img.size;
    NSInteger pw = (NSInteger)ceil(s.width * scale), ph = (NSInteger)ceil(s.height * scale);
    if (pw < 1 || ph < 1) return;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                                    pixelsWide:pw
                                                                    pixelsHigh:ph
                                                                 bitsPerSample:8
                                                               samplesPerPixel:4
                                                                      hasAlpha:YES
                                                                      isPlanar:NO
                                                                colorSpaceName:NSCalibratedRGBColorSpace
                                                                   bytesPerRow:0
                                                                  bitsPerPixel:0];
    rep.size = s;
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    [[NSColor clearColor] set];
    NSRectFill(NSMakeRect(0, 0, s.width, s.height));
    [img drawInRect:NSMakeRect(0, 0, s.width, s.height)];
    [NSGraphicsContext restoreGraphicsState];
    png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  });
  if (!png) return info.Env().Null();
  return Napi::Buffer<unsigned char>::Copy(info.Env(), (const unsigned char *)png.bytes, png.length);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setWindowToolbar", Napi::Function::New(env, SetWindowToolbar));
  exports.Set("symbolPNG", Napi::Function::New(env, SymbolPNG));
  return exports;
}
NODE_API_MODULE(band_native, Init)
