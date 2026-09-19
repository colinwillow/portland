"""Class vocabularies, shared with the runtime through the manifest.

The baker writes an INDEX; the manifest writes the NAME at that index; the
runtime maps names to colours and models. That seam is deliberate -- data
belongs to the bake, look belongs to the game, and retuning a palette must
never mean re-baking a city.
"""

BUILDING = ["house","detached","garage","outbuilding","apartments","residential",
            "commercial","retail","office","industrial","warehouse","civic",
            "education","religious","medical","hotel","parking","transit",
            "tower","other"]

ROAD = ["motorway","trunk","primary","secondary","tertiary","residential",
        "unclassified","living_street","service","driveway","parking_aisle",
        "alley","pedestrian","footway","sidewalk","crosswalk","steps","path",
        "cycleway","track","rail","unknown"]

# Carriageway width in metres when the data does not carry one. These are the
# numbers the collider and the kerb line both read, so a change here moves the
# pavement and the street trees together.
ROAD_WIDTH = {"motorway":14.0,"trunk":12.0,"primary":12.0,"secondary":10.5,
              "tertiary":9.0,"residential":8.0,"unclassified":7.0,
              "living_street":6.5,"service":5.0,"driveway":3.0,
              "parking_aisle":5.0,"alley":4.0,"pedestrian":6.0,"footway":1.8,
              "sidewalk":2.0,"crosswalk":3.2,"steps":1.8,"path":1.4,
              "cycleway":2.4,"track":3.0,"rail":3.0,"unknown":6.0}

# Streets that get a pavement generated down each side when OSM has not mapped
# one. A motorway has no pavement and a driveway does not need one.
PAVED = {"primary", "secondary", "tertiary", "residential", "unclassified",
         "living_street", "trunk"}

# Which classes get street furniture generated along them, and how eagerly.
# A motorway with a row of benches beside it is worse than a bare motorway.
STREETSCAPE = {"primary":1.0,"secondary":1.0,"tertiary":1.0,"residential":1.0,
               "unclassified":0.8,"living_street":0.8,"pedestrian":0.6}

AREA = ["water","river","pond","park","grass","forest","scrub","garden","pitch",
        "playground","sand","plaza","parking","school","religious","cemetery",
        "brownfield","construction","residential_lu","retail_lu","commercial_lu",
        "industrial_lu","wetland","railway","track"]

PROP = ["tree","tree_conifer","street_lamp","traffic_signal","stop_sign","bench",
        "hydrant","bin","bollard","bus_stop","post_box","drinking_fountain",
        "power_pole","artwork","bike_rack","planter","billboard","parking_meter",
        "newspaper_box","picnic_table","flagpole","fountain","car"]

# Where cars park, and how full the kerb is. A motorway has no kerb parking and
# a footway has no cars at all; putting a row of parked cars down either is the
# same class of wrong as a tree in the carriageway.
PARKING = {"residential": 0.62, "tertiary": 0.46, "secondary": 0.34,
           "unclassified": 0.52, "living_street": 0.55, "service": 0.22,
           "primary": 0.18}

BI = {n: i for i, n in enumerate(BUILDING)}
RI = {n: i for i, n in enumerate(ROAD)}
AI = {n: i for i, n in enumerate(AREA)}
PI = {n: i for i, n in enumerate(PROP)}

def building_class(cls, subtype, height):
    """Overture's class/subtype -> our palette bucket."""
    c, s = (cls or ""), (subtype or "")
    if c in BI: return BI[c]
    if c in ("apartments",): return BI["apartments"]
    if c in ("detached","semidetached_house","terrace","bungalow","static_caravan"):
        return BI["detached" if c == "detached" else "house"]
    if c in ("garage","garages","carport","shed","hut","roof"): return BI["garage"]
    if c in ("supermarket","kiosk","shop","mall"): return BI["retail"]
    if c in ("warehouse","factory","manufacture"): return BI["warehouse"]
    if c in ("church","chapel","cathedral","mosque","synagogue","temple"): return BI["religious"]
    if c in ("school","university","college","kindergarten"): return BI["education"]
    if c in ("hospital","clinic"): return BI["medical"]
    if c in ("hotel","motel","hostel"): return BI["hotel"]
    if c in ("parking",): return BI["parking"]
    if c in ("train_station","transportation"): return BI["transit"]
    if s == "commercial":  return BI["office"] if (height or 0) >= 24 else BI["commercial"]
    if s == "industrial":  return BI["industrial"]
    if s == "education":   return BI["education"]
    if s == "religious":   return BI["religious"]
    if s == "medical":     return BI["medical"]
    if s == "civic" or s == "service": return BI["civic"]
    if s == "transportation": return BI["transit"]
    if s == "outbuilding": return BI["outbuilding"]
    if s == "residential":
        return BI["apartments"] if (height or 0) >= 14 else BI["house"]
    if (height or 0) >= 60: return BI["tower"]
    return BI["other"]

# Typical storey height, and a fallback height when the data has neither a
# height nor a floor count. A garage guessed at 9 m ruins a whole block.
FALLBACK_H = {"house":6.5,"detached":6.5,"garage":3.0,"outbuilding":3.2,
              "apartments":13.0,"residential":9.0,"commercial":9.0,"retail":7.0,
              "office":22.0,"industrial":9.5,"warehouse":9.5,"civic":11.0,
              "education":10.0,"religious":11.0,"medical":14.0,"hotel":18.0,
              "parking":11.0,"transit":8.0,"tower":60.0,"other":7.0}

# 0 flat, 1 pitched. Portland's residential stock is overwhelmingly pitched and
# its commercial core is overwhelmingly flat; getting that split right is most
# of what makes a neighbourhood read as a neighbourhood.
PITCHED = {"house","detached","garage","outbuilding","religious","education"}

def area_class(cls, subtype):
    c, s = (cls or ""), (subtype or "")
    direct = {"river":"river","water":"water","pond":"pond","stream":"river",
              "swimming_pool":"pond","park":"park","grass":"grass","meadow":"grass",
              "forest":"forest","wood":"forest","tree":"forest","tree_row":"forest",
              "scrub":"scrub","shrubbery":"scrub","shrub":"scrub","heath":"scrub",
              "garden":"garden","pitch":"pitch","playground":"playground",
              "beach":"sand","sand":"sand","pedestrian":"plaza","plaza":"plaza",
              "parking":"parking","school":"school","religious":"religious",
              "cemetery":"cemetery","grave_yard":"cemetery","brownfield":"brownfield",
              "construction":"construction","residential":"residential_lu",
              "retail":"retail_lu","commercial":"commercial_lu",
              "industrial":"industrial_lu","wetland":"wetland","railway":"railway",
              "track":"track"}
    for k in (c, s):
        if k in direct: return AI[direct[k]]
    return None


# ---------------------------------------------------------------------------
# Businesses
# ---------------------------------------------------------------------------
# WHICH PLACES HAVE A SHOPFRONT. Overture's places theme is 20,127 rows over
# this city and most of them are a lawyer, an acupuncturist or a real-estate
# agent on the fourth floor -- real businesses with nothing on the street. What
# belongs on a facade is what you can see from the pavement, so the vocabulary
# below is a whitelist and everything else is skipped. It cuts 20,127 to about
# four thousand, which is the density a street actually has.
SHOP = ["food", "cafe", "bar", "shop", "grocery", "service", "salon", "bank",
        "pharmacy", "culture", "hotel", "civic", "landmark", "fuel", "other"]

SHOP_CATS = {
  "food": ["restaurant", "pizza", "sandwich", "burger", "sushi", "ramen", "thai",
           "mexican_restaurant", "italian_restaurant", "chinese_restaurant",
           "japanese_restaurant", "vietnamese_restaurant", "indian_restaurant",
           "korean_restaurant", "seafood_restaurant", "steakhouse", "diner",
           "fast_food_restaurant", "food_court", "food_truck", "deli",
           "breakfast_and_brunch_restaurant", "vegan_and_vegetarian_restaurant",
           "bagels", "donut", "ice_cream", "bakery", "dessert", "barbecue",
           "noodles", "tacos", "cafeteria", "pizza_restaurant"],
  "cafe": ["coffee_shop", "cafe", "tea_room", "juice_bar", "internet_cafe"],
  "bar":  ["bar", "pub", "brewery", "beer_bar", "wine_bar", "cocktail_bar",
           "nightlife", "night_club", "distillery", "sports_bar", "taproom",
           "brewpub", "lounge"],
  "shop": ["clothing_store", "shopping", "bookstore", "book_store", "gift_shop",
           "record_store", "music_store", "furniture_store", "thrift_store",
           "antique_store", "bike_shop", "skate_shop", "sporting_goods",
           "hardware_store", "toy_store", "pet_store", "florist", "jewelry_store",
           "shoe_store", "electronics", "home_and_garden", "vintage_store",
           "outlet_store", "department_store", "camera_store", "art_supply_store",
           "video_game_store", "comic_book_store", "cannabis_dispensary",
           "cannabis_store", "smoke_shop", "liquor_store"],
  "grocery": ["grocery_store", "supermarket", "convenience_store", "farmers_market",
              "butcher", "health_food_store", "market"],
  "service": ["laundry_service", "dry_cleaning", "print_shop", "shipping",
              "post_office", "repair_service", "tailor", "shoe_repair",
              "photo_shop", "veterinarian", "auto_repair", "car_wash"],
  "salon":  ["hair_salon", "barber", "beauty_salon", "nail_salon", "spa",
             "tattoo_parlor", "massage_therapy", "gym", "yoga_studio",
             "fitness_center", "dance_studio"],
  "bank":   ["bank", "credit_union", "atm", "financial_service"],
  "pharmacy": ["pharmacy", "drugstore"],
  "culture": ["art_gallery", "museum", "theatre", "theater", "cinema",
              "music_venue", "performing_arts", "library", "bowling",
              "arcade", "entertainment"],
  "hotel":  ["hotel", "motel", "hostel", "bed_and_breakfast", "inn"],
  "civic":  ["school", "college_university", "hospital", "fire_station",
             "police_department", "city_hall", "community_center", "church_cathedral",
             "place_of_worship", "post_office_box", "courthouse"],
  "landmark": ["landmark_and_historical_building", "monument", "tourist_attraction",
               "observation_deck"],
  "fuel":   ["gas_station", "charging_station", "ev_charging_station"],
}

SI = {n: i for i, n in enumerate(SHOP)}
_CAT = {}
for _k, _v in SHOP_CATS.items():
    for _c in _v:
        _CAT[_c] = SI[_k]

def shop_class(primary, alternates):
    """Overture's category -> a shopfront bucket, or None for no shopfront."""
    for c in [primary] + list(alternates or []):
        if not c:
            continue
        if c in _CAT:
            return _CAT[c]
    # A second pass on the WORD rather than the whole category, so a taxonomy
    # that grows a `peruvian_restaurant` tomorrow still lands on food.
    for c in [primary] + list(alternates or []):
        if not c:
            continue
        for word, bucket in (("restaurant", "food"), ("cafe", "cafe"),
                             ("coffee", "cafe"), ("bar", "bar"), ("brew", "bar"),
                             ("store", "shop"), ("shop", "shop"),
                             ("salon", "salon"), ("hotel", "hotel"),
                             ("market", "grocery"), ("gallery", "culture"),
                             ("theat", "culture"), ("museum", "culture")):
            if word in c:
                return SI[bucket]
    return None
