# -*- coding: utf-8 -*-
"""Adversarial hard-negative templates, part A.

These are all BENIGN rows. Each group deliberately borrows the vocabulary of one
dark pattern class while describing something legitimate, so that a bag-of-words
model can no longer separate classes on keywords alone.

Format: HARD_NEG_A[counterpart_class][lang] = [(template, tag, role), ...]

``counterpart_class`` records which dark class each row is designed to be
confused with. It is metadata only -- the label is always benign.

Slots available: PRODUCT NUM_SMALL NUM_BIG PRICE CITY DAYS PLAN NAME HOURS
"""

HARD_NEG_A = {
    # ------------------------------------------------------------------
    # vs SCARCITY: factual inventory display.
    # The single most important group. "Only 3 left in stock" is Amazon's
    # real inventory UI, not manipulation. Without these the model learns
    # that any mention of low stock is a dark pattern.
    # ------------------------------------------------------------------
    "scarcity": {
        "en": [
            ("Only {NUM_SMALL} left in stock", "span", "stock"),
            ("In stock: {NUM_BIG} units", "span", "stock"),
            ("{NUM_SMALL} units available at the {CITY} warehouse", "span", "stock"),
            ("{PRODUCT}: {NUM_SMALL} in stock, restocking in {DAYS} days", "p", "stock"),
            ("Out of stock in {CITY}. Available in other cities.", "p", "stock"),
            ("Stock levels update once daily", "span", "help_text"),
            ("Currently unavailable. Notify me when {PRODUCT} is back.", "p", "help_text"),
            ("{NUM_BIG} units in inventory across all warehouses", "span", "stock"),
            ("Last {NUM_SMALL} units of this size; other sizes in stock", "p", "stock"),
            ("Limited edition: {NUM_BIG} units produced", "span", "body"),
        ],
        "hi": [
            ("स्टॉक में केवल {NUM_SMALL} बचे हैं", "span", "stock"),
            ("स्टॉक में: {NUM_BIG} इकाई", "span", "stock"),
            ("{CITY} गोदाम में {NUM_SMALL} इकाई उपलब्ध", "span", "stock"),
            ("{PRODUCT}: {NUM_SMALL} स्टॉक में, {DAYS} दिन में पुनः स्टॉक", "p", "stock"),
            ("{CITY} में उपलब्ध नहीं। अन्य शहरों में उपलब्ध।", "p", "stock"),
            ("स्टॉक की जानकारी दिन में एक बार अपडेट होती है", "span", "help_text"),
            ("अभी उपलब्ध नहीं। {PRODUCT} आने पर सूचित करें।", "p", "help_text"),
            ("सभी गोदामों में {NUM_BIG} इकाई", "span", "stock"),
            ("इस साइज़ में {NUM_SMALL} बचे; अन्य साइज़ उपलब्ध", "p", "stock"),
            ("सीमित संस्करण: {NUM_BIG} इकाई बनाई गईं", "span", "body"),
        ],
        "ne": [
            ("स्टकमा {NUM_SMALL} मात्र बाँकी", "span", "stock"),
            ("स्टकमा: {NUM_BIG} थान", "span", "stock"),
            ("{CITY} गोदाममा {NUM_SMALL} थान उपलब्ध", "span", "stock"),
            ("{PRODUCT}: {NUM_SMALL} स्टकमा, {DAYS} दिनमा पुनः स्टक", "p", "stock"),
            ("{CITY} मा उपलब्ध छैन। अन्य सहरमा उपलब्ध छ।", "p", "stock"),
            ("स्टकको विवरण दिनको एक पटक अद्यावधिक हुन्छ", "span", "help_text"),
            ("अहिले उपलब्ध छैन। {PRODUCT} आएपछि सूचित गर्नुहोस्।", "p", "help_text"),
            ("सबै गोदाममा {NUM_BIG} थान", "span", "stock"),
            ("यो साइजमा {NUM_SMALL} बाँकी; अन्य साइज उपलब्ध", "p", "stock"),
            ("सीमित संस्करण: {NUM_BIG} थान उत्पादन", "span", "body"),
        ],
    },
    # ------------------------------------------------------------------
    # vs FALSE_URGENCY: honest, verifiable deadlines.
    # A real sale really does end. The manipulation is a fake or resetting
    # deadline, not the existence of one.
    # ------------------------------------------------------------------
    "false_urgency": {
        "en": [
            ("Sale ends {DAYS} days from today", "span", "promo"),
            ("Offer valid until the end of the month", "span", "fine_print"),
            ("Coupon expires in {DAYS} days", "span", "fine_print"),
            ("Order within {HOURS} hours for delivery by {DAYS} days", "p", "help_text"),
            ("Return window: {DAYS} days from delivery", "p", "fine_print"),
            ("Free shipping ends when the festival sale closes", "span", "promo"),
            ("Prices return to normal after the sale period", "p", "fine_print"),
            ("Warranty registration closes {DAYS} days after purchase", "p", "fine_print"),
            ("Bank offer applies until the last day of the month", "span", "fine_print"),
            ("Exchange requests accepted for {DAYS} days", "p", "help_text"),
        ],
        "hi": [
            ("सेल आज से {DAYS} दिन में समाप्त", "span", "promo"),
            ("ऑफ़र महीने के अंत तक मान्य", "span", "fine_print"),
            ("कूपन {DAYS} दिन में समाप्त होगा", "span", "fine_print"),
            ("{DAYS} दिन में डिलीवरी के लिए {HOURS} घंटे में ऑर्डर करें", "p", "help_text"),
            ("वापसी अवधि: डिलीवरी से {DAYS} दिन", "p", "fine_print"),
            ("फेस्टिवल सेल समाप्त होने पर मुफ़्त शिपिंग बंद", "span", "promo"),
            ("सेल अवधि के बाद कीमतें सामान्य हो जाएँगी", "p", "fine_print"),
            ("खरीद के {DAYS} दिन बाद वारंटी रजिस्ट्रेशन बंद", "p", "fine_print"),
            ("बैंक ऑफ़र महीने के अंतिम दिन तक लागू", "span", "fine_print"),
            ("एक्सचेंज अनुरोध {DAYS} दिन तक स्वीकार्य", "p", "help_text"),
        ],
        "ne": [
            ("सेल आजबाट {DAYS} दिनमा सकिन्छ", "span", "promo"),
            ("अफर महिनाको अन्तसम्म मान्य", "span", "fine_print"),
            ("कुपन {DAYS} दिनमा सकिन्छ", "span", "fine_print"),
            ("{DAYS} दिनमा डिलिभरीको लागि {HOURS} घण्टाभित्र अर्डर गर्नुहोस्", "p", "help_text"),
            ("फिर्ता अवधि: डिलिभरीबाट {DAYS} दिन", "p", "fine_print"),
            ("चाडपर्व सेल सकिएपछि निःशुल्क ढुवानी बन्द", "span", "promo"),
            ("सेल अवधिपछि मूल्य सामान्य हुनेछ", "p", "fine_print"),
            ("खरिदको {DAYS} दिनपछि वारेन्टी दर्ता बन्द", "p", "fine_print"),
            ("बैंक अफर महिनाको अन्तिम दिनसम्म लागू", "span", "fine_print"),
            ("एक्सचेन्ज अनुरोध {DAYS} दिनसम्म स्वीकार्य", "p", "help_text"),
        ],
    },
    # ------------------------------------------------------------------
    # vs SOCIAL_PROOF: verifiable aggregate statistics.
    # A real review count is information. The manipulation is a fabricated
    # or unverifiable count, or manufactured live-viewer pressure.
    # ------------------------------------------------------------------
    "social_proof": {
        "en": [
            ("{NUM_BIG} verified reviews", "span", "badge"),
            ("{NUM_BIG} customers bought this last month", "span", "body"),
            ("Rated by {NUM_BIG} buyers", "span", "badge"),
            ("Bestseller in {PRODUCT}", "span", "badge"),
            ("{NUM_BIG} shoppers saved this to a wishlist", "span", "body"),
            ("Based on {NUM_BIG} verified purchases", "p", "fine_print"),
            ("Average rating calculated from {NUM_BIG} reviews", "p", "help_text"),
            ("Reviews are from confirmed buyers only", "p", "help_text"),
            ("{NAME} and {NUM_BIG} others reviewed this", "span", "body"),
            ("Ranked #{NUM_SMALL} in this category by sales", "span", "badge"),
        ],
        "hi": [
            ("{NUM_BIG} सत्यापित समीक्षाएँ", "span", "badge"),
            ("पिछले महीने {NUM_BIG} ग्राहकों ने खरीदा", "span", "body"),
            ("{NUM_BIG} खरीदारों ने रेटिंग दी", "span", "badge"),
            ("{PRODUCT} में बेस्टसेलर", "span", "badge"),
            ("{NUM_BIG} ग्राहकों ने विशलिस्ट में जोड़ा", "span", "body"),
            ("{NUM_BIG} सत्यापित खरीद पर आधारित", "p", "fine_print"),
            ("औसत रेटिंग {NUM_BIG} समीक्षाओं से", "p", "help_text"),
            ("समीक्षाएँ केवल पुष्ट खरीदारों से", "p", "help_text"),
            ("{NAME} और {NUM_BIG} अन्य ने समीक्षा की", "span", "body"),
            ("बिक्री के आधार पर श्रेणी में #{NUM_SMALL}", "span", "badge"),
        ],
        "ne": [
            ("{NUM_BIG} प्रमाणित समीक्षा", "span", "badge"),
            ("गत महिना {NUM_BIG} ग्राहकले किन्नुभयो", "span", "body"),
            ("{NUM_BIG} खरिदकर्ताले मूल्याङ्कन गरे", "span", "badge"),
            ("{PRODUCT} मा बेस्टसेलर", "span", "badge"),
            ("{NUM_BIG} ग्राहकले इच्छासूचीमा राखे", "span", "body"),
            ("{NUM_BIG} प्रमाणित खरिदमा आधारित", "p", "fine_print"),
            ("औसत मूल्याङ्कन {NUM_BIG} समीक्षाबाट", "p", "help_text"),
            ("समीक्षा पुष्टि भएका खरिदकर्ताबाट मात्र", "p", "help_text"),
            ("{NAME} र {NUM_BIG} अन्यले समीक्षा गरे", "span", "body"),
            ("बिक्रीको आधारमा श्रेणीमा #{NUM_SMALL}", "span", "badge"),
        ],
    },
}
