#!/bin/bash
# Virtual microphone: PulseAudio null sink whose monitor is the default source.
pulseaudio --check 2>/dev/null || pulseaudio --start --exit-idle-time=-1 --disallow-exit 2>/dev/null
sleep 1
pactl list short sinks | grep -q vmic || pactl load-module module-null-sink sink_name=vmic sink_properties=device.description=VirtualMic >/dev/null
pactl list short sources | grep -q vmic_src || pactl load-module module-remap-source master=vmic.monitor source_name=vmic_src source_properties=device.description=VirtualMicSrc >/dev/null
pactl set-default-source vmic_src
pactl set-default-sink vmic
pactl info | grep -E "Default (Source|Sink)"
