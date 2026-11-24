@pose rest {
    head reset;
    neck reset;
    waist reset;
    upper_body reset;
    shoulder_l reset;
    shoulder_r reset;
    arm_l reset;
    arm_r reset;
    elbow_r reset;
    wrist_r reset;
}

@pose greet {
    head turn right 15;
    neck turn right 10;
    shoulder_r bend backward 20;
    arm_r bend backward 30;
    elbow_r bend forward 60;
    wrist_r sway left 15;
}

@pose wave_hi {
    head turn right 10;
    shoulder_r bend backward 25, sway left 15;
    arm_r bend backward 55;
    elbow_r bend forward 90;
    wrist_r sway left 25;
}

@pose wave_lo {
    head turn right 10;
    shoulder_r bend backward 25, sway left 15;
    arm_r bend backward 55;
    elbow_r bend forward 90;
    wrist_r sway right 15;
}

@pose bow {
    waist bend forward 30;
    upper_body bend forward 25;
    neck bend forward 15;
    head bend forward 10;
    arm_l bend forward 15;
    arm_r bend forward 15;
}

@pose look_left {
    waist bend forward 30;
    upper_body bend forward 25;
    head turn left 25;
    neck turn left 15;
}

@pose look_right {
    waist bend forward 30;
    upper_body bend forward 25;
    head turn right 25;
    neck turn right 15;
}

@animation greeting_show {
    0: rest;
    0.6: greet;
    1.0: wave_hi;
    1.3: wave_lo;
    1.6: wave_hi;
    1.9: wave_lo;
    2.2: wave_hi;
    2.6: greet;
    3.2: bow;
    4.0: look_left;
    4.4: look_right;
    4.8: rest;
    5.2: rest;
}

main {
    greeting_show;
}
