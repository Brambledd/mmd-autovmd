@pose stand_ready {
    upper_body reset;
    neck reset;
    head reset;
    shoulder_l reset;
    shoulder_r reset;
    arm_l reset;
    arm_r reset;
    elbow_l reset;
    elbow_r reset;
    wrist_l reset;
    wrist_r reset;
}

@pose wave_hi {
    upper_body turn left 5;
    neck turn left 5;
    head turn left 10;
    shoulder_r bend forward 25, sway left 35, turn left 55;
    arm_r bend backward 20;
    elbow_r bend forward 80;
    wrist_r bend forward 10;
    index_r bend forward 35;
    middle_r bend forward 35;
    ring_r bend forward 35;
    pinky_r bend forward 35;
    shoulder_l bend backward 20;
    arm_l bend backward 45;
    elbow_l bend forward 115;
    wrist_l bend forward 10;
    index_l bend forward 15;
    middle_l bend forward 15;
    ring_l bend forward 15;
    pinky_l bend forward 15;
    face にこり 0.5;
}

@pose wave_lo {
    upper_body turn left 5;
    neck turn left 5;
    head turn left 10;
    shoulder_r bend forward 25, sway left 35, turn left 55;
    arm_r bend backward 20;
    elbow_r bend forward 80;
    wrist_r bend forward 10;
    index_r bend forward 35;
    middle_r bend forward 35;
    ring_r bend forward 35;
    pinky_r bend forward 35;
    shoulder_l bend backward 20;
    arm_l bend backward 45;
    elbow_l bend forward 60;
    wrist_l bend forward 10;
    index_l bend forward 15;
    middle_l bend forward 15;
    ring_l bend forward 15;
    pinky_l bend forward 15;
    face にこり 0.5;
}

@pose akimbo_hold {
    upper_body turn left 5;
    neck turn left 5;
    head turn left 10;
    shoulder_r bend forward 25, sway left 35, turn left 55;
    arm_r bend backward 20;
    elbow_r bend forward 80;
    wrist_r bend forward 10;
    index_r bend forward 35;
    middle_r bend forward 35;
    ring_r bend forward 35;
    pinky_r bend forward 35;
    shoulder_l bend backward 20;
    arm_l bend backward 45;
    elbow_l bend forward 90;
    wrist_l bend forward 10;
    index_l bend forward 15;
    middle_l bend forward 15;
    ring_l bend forward 15;
    pinky_l bend forward 15;
    face にこり 0.5;
}

@animation akimbo_wave {
    0: stand_ready;
    0.5: wave_hi;
    0.85: wave_lo;
    1.2: wave_hi;
    1.55: wave_lo;
    1.9: wave_hi;
    2.3: akimbo_hold;
}

main {
    akimbo_wave;
}
