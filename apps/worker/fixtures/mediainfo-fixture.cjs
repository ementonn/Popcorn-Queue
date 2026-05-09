#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--Version")) {
  console.log("MediaInfo Command line,");
  console.log("MediaInfoLib - v24.01-test");
  process.exit(0);
}

if (args[0] === "--Output=JSON") {
  console.log(
    JSON.stringify({
      media: {
        track: [
          {
            "@type": "General",
            Format: "Matroska",
            Duration: "2.000"
          },
          {
            "@type": "Video",
            Format: "HEVC",
            Width: "1920",
            Height: "1080",
            HDR_Format: "SMPTE ST 2086"
          },
          {
            "@type": "Audio",
            Format: "E-AC-3",
            Language: "en"
          },
          {
            "@type": "Text",
            Format: "UTF-8",
            Language: "en"
          }
        ]
      }
    })
  );
  process.exit(0);
}

console.log(`General
Format                                   : Matroska
Duration                                 : 2 s

Video
Format                                   : HEVC
Width                                    : 1 920 pixels
Height                                   : 1 080 pixels

Audio
Format                                   : E-AC-3
Language                                 : English

Text
Format                                   : UTF-8
Language                                 : English`);
