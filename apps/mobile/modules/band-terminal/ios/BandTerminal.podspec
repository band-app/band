Pod::Spec.new do |s|
  s.name           = 'BandTerminal'
  s.version        = '0.1.0'
  s.summary        = 'Native terminal view for Band, built on SwiftTerm'
  s.description    = 'An Expo module that shows a terminal with a vendored SwiftTerm. JavaScript feeds it bytes and reads keystrokes and the size.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Band'
  s.homepage       = 'https://github.com/band-app/band'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/band-app/band.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # SwiftTerm is vendored in SwiftTerm/ (see VENDORED.md).
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
