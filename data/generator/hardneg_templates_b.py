# -*- coding: utf-8 -*-
"""Adversarial hard-negative templates, part B.

All BENIGN. See hardneg_templates_a.py for the rationale and format.

Format: HARD_NEG_B[counterpart_class][lang] = [(template, tag, role), ...]

Slots available: PRODUCT NUM_SMALL NUM_BIG PRICE CITY DAYS PLAN NAME HOURS
"""

HARD_NEG_B = {
    # ------------------------------------------------------------------
    # vs CONFIRMSHAMING: neutral decline wording.
    # Critical group. A decline button must exist on every opt-out flow.
    # "No thanks" is neutral; "No thanks, I hate saving money" is the dark
    # pattern. Without these the model learns that any decline button is
    # confirmshaming -- guaranteeing false positives on well-designed sites.
    # ------------------------------------------------------------------
    "confirmshaming": {
        "en": [
            ("No thanks", "button", "decline"),
            ("Not now", "button", "decline"),
            ("Maybe later", "button", "decline"),
            ("Skip for now", "button", "decline"),
            ("Decline", "button", "decline"),
            ("Continue without the offer", "button", "decline"),
            ("Dismiss", "button", "decline"),
            ("No, thank you", "a", "decline"),
            ("Close this message", "button", "decline"),
            ("I'll decide later", "button", "decline"),
        ],
        "hi": [
            ("नहीं, धन्यवाद", "button", "decline"),
            ("अभी नहीं", "button", "decline"),
            ("बाद में", "button", "decline"),
            ("अभी छोड़ें", "button", "decline"),
            ("अस्वीकार करें", "button", "decline"),
            ("ऑफ़र के बिना जारी रखें", "button", "decline"),
            ("बंद करें", "button", "decline"),
            ("नहीं", "a", "decline"),
            ("यह संदेश बंद करें", "button", "decline"),
            ("मैं बाद में तय करूंगा", "button", "decline"),
        ],
        "ne": [
            ("पर्दैन, धन्यवाद", "button", "decline"),
            ("अहिले होइन", "button", "decline"),
            ("पछि हेर्छु", "button", "decline"),
            ("अहिलेको लागि छोड्नुहोस्", "button", "decline"),
            ("अस्वीकार गर्नुहोस्", "button", "decline"),
            ("अफरबिना जारी राख्नुहोस्", "button", "decline"),
            ("बन्द गर्नुहोस्", "button", "decline"),
            ("पर्दैन", "a", "decline"),
            ("यो सन्देश बन्द गर्नुहोस्", "button", "decline"),
            ("म पछि निर्णय गर्छु", "button", "decline"),
        ],
    },
    # ------------------------------------------------------------------
    # vs OBSTRUCTION: genuinely easy cancellation and real support access.
    # The word "contact" was a perfect giveaway for obstruction. These use
    # the same support vocabulary while describing frictionless paths.
    # ------------------------------------------------------------------
    "obstruction": {
        "en": [
            ("Cancel anytime in Settings", "a", "support_link"),
            ("Cancel your order online in one click", "p", "help_text"),
            ("Manage or cancel your {PLAN} plan online", "a", "support_link"),
            ("Returns are free within {DAYS} days", "p", "help_text"),
            ("Unsubscribe using the link at the bottom of any email", "p", "fine_print"),
            ("Track or cancel your order from My Orders", "a", "support_link"),
            ("Contact support anytime; we reply within {HOURS} hours", "p", "help_text"),
            ("Live chat available {HOURS} hours a day", "span", "support_link"),
            ("Refunds are processed within {DAYS} days automatically", "p", "help_text"),
            ("Close your account from Account Settings", "a", "support_link"),
        ],
        "hi": [
            ("सेटिंग्स में कभी भी रद्द करें", "a", "support_link"),
            ("अपना ऑर्डर ऑनलाइन एक क्लिक में रद्द करें", "p", "help_text"),
            ("अपनी {PLAN} योजना ऑनलाइन बदलें या रद्द करें", "a", "support_link"),
            ("{DAYS} दिन के भीतर वापसी मुफ़्त है", "p", "help_text"),
            ("किसी भी ईमेल के नीचे दिए लिंक से सदस्यता रद्द करें", "p", "fine_print"),
            ("मेरे ऑर्डर से ऑर्डर ट्रैक या रद्द करें", "a", "support_link"),
            ("कभी भी संपर्क करें; हम {HOURS} घंटे में उत्तर देते हैं", "p", "help_text"),
            ("लाइव चैट दिन में {HOURS} घंटे उपलब्ध", "span", "support_link"),
            ("रिफंड {DAYS} दिन में स्वतः हो जाता है", "p", "help_text"),
            ("खाता सेटिंग्स से खाता बंद करें", "a", "support_link"),
        ],
        "ne": [
            ("सेटिङमा जुनसुकै बेला रद्द गर्नुहोस्", "a", "support_link"),
            ("अर्डर अनलाइन एक क्लिकमा रद्द गर्नुहोस्", "p", "help_text"),
            ("तपाईंको {PLAN} योजना अनलाइन बदल्नु वा रद्द गर्नुहोस्", "a", "support_link"),
            ("{DAYS} दिनभित्र फिर्ता निःशुल्क छ", "p", "help_text"),
            ("कुनै पनि इमेलको तल्लो लिङ्कबाट सदस्यता रद्द गर्नुहोस्", "p", "fine_print"),
            ("मेरो अर्डरबाट अर्डर ट्र्याक वा रद्द गर्नुहोस्", "a", "support_link"),
            ("जुनसुकै बेला सम्पर्क गर्नुहोस्; {HOURS} घण्टामा जवाफ दिन्छौं", "p", "help_text"),
            ("लाइभ च्याट दिनको {HOURS} घण्टा उपलब्ध", "span", "support_link"),
            ("रिफन्ड {DAYS} दिनमा स्वतः हुन्छ", "p", "help_text"),
            ("खाता सेटिङबाट खाता बन्द गर्नुहोस्", "a", "support_link"),
        ],
    },
    # ------------------------------------------------------------------
    # vs FORCED_ACTION: legitimate, proportionate requirements.
    # Asking for an address to compute shipping is necessary. Demanding a
    # card for a "free" trial is not. Same imperative verbs either way.
    # ------------------------------------------------------------------
    "forced_action": {
        "en": [
            ("Sign in to view your order history", "p", "form_gate"),
            ("Enter your PIN code to check delivery", "label", "form"),
            ("Verify your email to secure your account", "p", "form_gate"),
            ("Add a delivery address to continue", "label", "form"),
            ("Create an account to save your wishlist", "p", "form_gate"),
            ("Log in to apply your saved coupon", "p", "form_gate"),
            ("Register your warranty for {PRODUCT}", "a", "support_link"),
            ("Enter the OTP sent to your phone", "label", "form"),
            ("Select a size to add to cart", "label", "form"),
            ("Guest checkout available; no account needed", "p", "help_text"),
        ],
        "hi": [
            ("ऑर्डर इतिहास देखने के लिए साइन इन करें", "p", "form_gate"),
            ("डिलीवरी जाँचने के लिए पिन कोड डालें", "label", "form"),
            ("खाता सुरक्षित करने के लिए ईमेल सत्यापित करें", "p", "form_gate"),
            ("जारी रखने के लिए डिलीवरी पता जोड़ें", "label", "form"),
            ("विशलिस्ट सहेजने के लिए खाता बनाएँ", "p", "form_gate"),
            ("सहेजा कूपन लगाने के लिए लॉग इन करें", "p", "form_gate"),
            ("{PRODUCT} की वारंटी रजिस्टर करें", "a", "support_link"),
            ("फोन पर भेजा गया OTP डालें", "label", "form"),
            ("कार्ट में जोड़ने के लिए साइज़ चुनें", "label", "form"),
            ("गेस्ट चेकआउट उपलब्ध; खाता आवश्यक नहीं", "p", "help_text"),
        ],
        "ne": [
            ("अर्डर इतिहास हेर्न साइन इन गर्नुहोस्", "p", "form_gate"),
            ("डिलिभरी जाँच्न पिन कोड राख्नुहोस्", "label", "form"),
            ("खाता सुरक्षित गर्न इमेल प्रमाणित गर्नुहोस्", "p", "form_gate"),
            ("जारी राख्न डिलिभरी ठेगाना थप्नुहोस्", "label", "form"),
            ("इच्छासूची सुरक्षित गर्न खाता बनाउनुहोस्", "p", "form_gate"),
            ("सुरक्षित कुपन लागू गर्न लगइन गर्नुहोस्", "p", "form_gate"),
            ("{PRODUCT} को वारेन्टी दर्ता गर्नुहोस्", "a", "support_link"),
            ("मोबाइलमा पठाइएको OTP राख्नुहोस्", "label", "form"),
            ("कार्टमा थप्न साइज छान्नुहोस्", "label", "form"),
            ("गेस्ट चेक̐उट उपलब्ध; खाता आवश्यक छैन", "p", "help_text"),
        ],
    },
    # ------------------------------------------------------------------
    # vs SNEAKING: transparent, up-front fee disclosure.
    # Words like "fee" and "charge" were near-exclusive to sneaking. A fee
    # disclosed before payment is the opposite of sneaking.
    # ------------------------------------------------------------------
    "sneaking": {
        "en": [
            ("Delivery fee Rs. {PRICE}, shown before payment", "span", "line_item"),
            ("All taxes and fees included in the price shown", "p", "fine_print"),
            ("Handling fee: Rs. {PRICE} (itemised at checkout)", "span", "line_item"),
            ("No hidden charges", "span", "badge"),
            ("Shipping charge of Rs. {PRICE} applies to {CITY}", "p", "line_item"),
            ("Your {PLAN} plan renews in {DAYS} days; cancel anytime", "p", "fine_print"),
            ("Service fee waived on orders above Rs. {PRICE}", "span", "promo"),
            ("Total includes GST of Rs. {PRICE}", "span", "line_item"),
            ("Packaging is free; no separate charge", "span", "help_text"),
            ("Price breakdown shown before you pay", "p", "help_text"),
        ],
        "hi": [
            ("डिलीवरी शुल्क रु. {PRICE}, भुगतान से पहले दिखाया गया", "span", "line_item"),
            ("दिखाई गई कीमत में सभी कर और शुल्क शामिल", "p", "fine_print"),
            ("हैंडलिंग शुल्क: रु. {PRICE} (चेकआउट में विवरण)", "span", "line_item"),
            ("कोई छिपा शुल्क नहीं", "span", "badge"),
            ("{CITY} के लिए रु. {PRICE} शिपिंग शुल्क लागू", "p", "line_item"),
            ("आपकी {PLAN} योजना {DAYS} दिन में नवीकरण; कभी भी रद्द करें", "p", "fine_print"),
            ("रु. {PRICE} से अधिक के ऑर्डर पर सेवा शुल्क माफ़", "span", "promo"),
            ("कुल में रु. {PRICE} GST शामिल", "span", "line_item"),
            ("पैकेजिंग मुफ़्त; अलग शुल्क नहीं", "span", "help_text"),
            ("भुगतान से पहले कीमत का विवरण दिखाया जाता है", "p", "help_text"),
        ],
        "ne": [
            ("ढुवानी शुल्क रु. {PRICE}, भुक्तानी अगाडि देखाइन्छ", "span", "line_item"),
            ("देखाइएको मूल्यमा सबै कर र शुल्क समाविष्ट", "p", "fine_print"),
            ("ह्यान्डलिङ शुल्क: रु. {PRICE} (चेक̐उटमा विवरण)", "span", "line_item"),
            ("कुनै लुकिएको शुल्क छैन", "span", "badge"),
            ("{CITY} का लागि रु. {PRICE} ढुवानी शुल्क लागू", "p", "line_item"),
            ("तपाईंको {PLAN} योजना {DAYS} दिनमा नवीकरण; जुनसुकै बेला रद्द", "p", "fine_print"),
            ("रु. {PRICE} माथिको अर्डरमा सेवा शुल्क मिनाहा", "span", "promo"),
            ("जम्मामा रु. {PRICE} मूल्य अभिवूद्धि कर समाविष्ट", "span", "line_item"),
            ("प्याकेजिङ निःशुल्क; अलग शुल्क छैन", "span", "help_text"),
            ("भुक्तानी अगाडि मूल्य विवरण देखाइन्छ", "p", "help_text"),
        ],
    },
}
