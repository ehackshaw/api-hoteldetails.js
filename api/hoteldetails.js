
/*
==========================================================
BOKKARA — COMPLETE HOTEL DETAILS BACKEND
File: api/hoteldetails.js
==========================================================

- One request from Shopify to Vercel
- Hotel information and booking prices
- Hotel and room-specific photos
- Up to 50 reviews through server-side pagination
- Reviewer profile pictures
- Review photo URLs
- Compatible hotel, gallery, reviews and pricing output
- No fabricated images, rooms or reviews

Required Vercel environment variable:
SERPAPI_API_KEY
==========================================================
*/

const SERPAPI_URL = "https://serpapi.com/search.json";
const TIMEOUT_MS = 25000;
const MAX_REVIEWS = 50;
const MAX_REVIEW_PAGES = 5;

/* ========================================================
   UTILITIES
======================================================== */

function obj(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function first(...values) {
  return values.find(value =>
    value !== undefined &&
    value !== null &&
    value !== ""
  ) ?? null;
}

function str(value) {
  return value == null ||
    typeof value === "object"
    ? ""
    : String(value).trim();
}

function num(value) {
  if (value == null || value === "") return null;

  if (typeof value === "object") {
    return num(first(
      value.extracted_lowest,
      value.extracted_price,
      value.amount,
      value.value
    ));
  }

  const parsed = Number(
    String(value).replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function httpUrl(value) {
  const candidate = str(value);
  return /^https?:\/\//i.test(candidate)
    ? candidate
    : "";
}

function imageUrl(value) {
  if (typeof value === "string") {
    return httpUrl(value);
  }

  const data = obj(value);

  return httpUrl(first(
    data.original_image,
    data.image_url,
    data.original,
    data.url,
    data.image,
    data.src,
    data.photo,
    data.thumbnail,
    data.avatar,
    data.picture
  ));
}

function unique(items, keyFn) {
  const seen = new Set();

  return items.filter(item => {
    const key = keyFn(item);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function integer(value, fallback, min, max) {
  const parsed = Number(value);

  return Number.isInteger(parsed) &&
    parsed >= min &&
    parsed <= max
    ? parsed
    : fallback;
}

function parseDate(value) {
  const input = str(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const date = new Date(input + "T00:00:00Z");

    return !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === input
      ? input
      : "";
  }

  if (!input) return "";

  const date = new Date(input);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toISOString().slice(0, 10);
}

function normalizeRate(value) {
  const data = obj(value);

  return {
    display: str(first(
      data.lowest,
      data.price,
      data.amount
    )),

    amount: num(first(
      data.extracted_lowest,
      data.extracted_price,
      data.amount
    )),

    before_taxes_fees: str(
      data.before_taxes_fees
    ),

    before_taxes_fees_amount: num(
      data.extracted_before_taxes_fees
    ),

    raw: data
  };
}

/* ========================================================
   QUERY PARAMETERS
======================================================== */

function getQuery(req) {
  const q = req.method === "POST"
    ? obj(req.body)
    : obj(req.query);

  const currency = str(
    q.currency || "USD"
  ).toUpperCase();

  return {
    property_token: str(first(
      q.property_token,
      q.propertyToken,
      q.token
    )),

    destination: str(first(
      q.destination,
      q.q,
      q.location
    )),

    checkin: parseDate(first(
      q.checkin,
      q.check_in_date
    )),

    checkout: parseDate(first(
      q.checkout,
      q.check_out_date
    )),

    rooms: integer(q.rooms, 1, 1, 10),
    adults: integer(q.adults, 2, 1, 40),
    children: integer(q.children, 0, 0, 40),
    babies: integer(q.babies, 0, 0, 40),
    seniors: integer(q.seniors, 0, 0, 40),

    children_ages: str(q.children_ages),

    currency: /^[A-Z]{3}$/.test(currency)
      ? currency
      : "USD",

    hl: "en",
    gl: "us"
  };
}

function validateQuery(q) {
  if (
    !q.property_token ||
    q.property_token.length > 2048
  ) {
    throw new Error(
      "A valid property_token is required."
    );
  }

  if (!q.destination) {
    throw new Error("Destination is required.");
  }

  if (!q.checkin || !q.checkout) {
    throw new Error(
      "Valid check-in and check-out dates are required."
    );
  }

  if (q.checkout <= q.checkin) {
    throw new Error(
      "Checkout must be later than check-in."
    );
  }

  if (q.children_ages) {
    const ages = q.children_ages.split(",");

    if (
      ages.length !== q.children ||
      ages.some(age =>
        !/^\d{1,2}$/.test(age.trim()) ||
        Number(age) < 1 ||
        Number(age) > 17
      )
    ) {
      throw new Error("Invalid children_ages.");
    }
  }
}

/* ========================================================
   SERPAPI
======================================================== */

async function callSerpApi(engine, params, apiKey) {
  const endpoint = new URL(SERPAPI_URL);

  endpoint.searchParams.set("engine", engine);
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("output", "json");

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      endpoint.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(
        str(data.error) ||
        `${engine} returned HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ========================================================
   PHOTO NORMALIZATION
======================================================== */

function normalizePhoto(value, section = "") {
  const data = typeof value === "string"
    ? { url: value }
    : obj(value);

  const url = imageUrl(data);

  if (!url) return null;

  return {
    url,

    original_image:
      imageUrl(data.original_image) || url,

    thumbnail:
      imageUrl(data.thumbnail) || url,

    title: str(first(
      data.title,
      data.caption,
      data.description
    )),

    section,

    raw: data
  };
}

function photoItems(value, section = "") {
  const items = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];

  return items
    .map(item => normalizePhoto(item, section))
    .filter(Boolean);
}

function normalizePhotos(data) {
  const source = obj(data);

  const sections = arr(source.sections).map(value => {
    const section = obj(value);
    const title = str(section.title);

    return {
      title,

      total: num(section.total),

      photos: photoItems(
        first(section.photos, section.images),
        title
      ),

      next_page_token:
        str(section.next_page_token) || null,

      raw: section
    };
  });

  const photos = unique(
    [
      ...photoItems(first(
        source.photos,
        source.images
      )),

      ...sections.flatMap(
        section => section.photos
      )
    ],
    photo => photo.url
  );

  return {
    sections,
    photos,
    photo_urls: photos.map(photo => photo.url),
    photo_count_loaded: photos.length,

    has_more_photos: sections.some(
      section => Boolean(section.next_page_token)
    )
  };
}

/* ========================================================
   ROOM PHOTOGRAPHS
======================================================== */

function roomName(value) {
  const room = obj(value);

  return str(first(
    room.name,
    room.room_name,
    room.title,
    room.type
  ));
}

function normalizeRoom(value, sections = []) {
  const room = obj(value);
  const name = roomName(room);

  const directPhotos = [
    ...photoItems(room.images),
    ...photoItems(room.photos),
    ...photoItems(room.room_images),
    ...photoItems(room.room_photos),
    ...photoItems(room.image),
    ...photoItems(room.thumbnail),
    ...photoItems(room.photo)
  ];

  // Match only gallery sections explicitly named
  // after the room. Never use unrelated hotel photos.
  const matchingSections = sections.filter(section => {
    const title = str(
      section.title
    ).toLowerCase().trim();

    const label = name.toLowerCase().trim();

    return (
      title.length >= 4 &&
      label.length >= 4 &&
      (
        title === label ||
        title.includes(label) ||
        label.includes(title)
      )
    );
  });

  const images = unique(
    [
      ...directPhotos,

      ...matchingSections.flatMap(
        section => arr(section.photos)
      )
    ],
    photo => photo.url
  );

  return {
    ...room,

    name,

    images,

    photos: images.map(photo => photo.url),

    image: images[0]?.url || "",

    thumbnail:
      images[0]?.thumbnail || "",

    image_count: images.length,

    has_room_photos: images.length > 0
  };
}

function attachRoomImages(hotel, gallery) {
  const sections = arr(gallery.sections);

  hotel.room_options = arr(
    hotel.room_options
  ).map(room =>
    normalizeRoom(room, sections)
  );

  const featuredCount =
    hotel.featured_prices.length;

  hotel.booking_options = arr(
    hotel.booking_options
  ).map(option => ({
    ...option,

    rooms: arr(option.rooms).map(
      room => normalizeRoom(room, sections)
    )
  }));

  hotel.featured_prices =
    hotel.booking_options.slice(
      0,
      featuredCount
    );

  hotel.prices =
    hotel.booking_options.slice(
      featuredCount
    );
}

/* ========================================================
   BOOKING OPTIONS
======================================================== */

function normalizeBookingOption(value) {
  const option = obj(value);

  return {
    source: str(first(
      option.source,
      option.name
    )),

    link: httpUrl(option.link),
    logo: httpUrl(option.logo),

    num_guests: num(option.num_guests),

    rate_per_night: normalizeRate(
      option.rate_per_night
    ),

    total_rate: normalizeRate(
      option.total_rate
    ),

    rooms: arr(option.rooms),

    benefits: first(
      option.benefits,
      null
    ),

    raw: option
  };
}

/* ========================================================
   HOTEL PROPERTY
======================================================== */

function normalizeProperty(data, q) {
  const p = obj(data);
  const gps = obj(p.gps_coordinates);

  const address = str(first(
    p.address,
    p.formatted_address,
    p.full_address,
    p.street_address
  ));

  const featured = arr(
    p.featured_prices
  ).map(normalizeBookingOption);

  const prices = arr(
    p.prices
  ).map(normalizeBookingOption);

  const nightly = normalizeRate(
    p.rate_per_night
  );

  const total = normalizeRate(
    p.total_rate
  );

  const rating = num(first(
    p.overall_rating,
    p.rating,
    p.guest_rating
  ));

  const nights = Math.round(
    (
      Date.parse(q.checkout + "T00:00:00Z") -
      Date.parse(q.checkin + "T00:00:00Z")
    ) / 86400000
  );

  return {
    property_token: str(first(
      p.property_token,
      q.property_token
    )),

    name: str(p.name),
    type: str(p.type),
    description: str(p.description),

    website: httpUrl(p.link),
    logo: httpUrl(p.logo),

    address,
    address_available: Boolean(address),
    location_label: address || q.destination,

    phone: str(p.phone),
    phone_link: str(p.phone_link),

    gps_coordinates: {
      latitude: num(gps.latitude),
      longitude: num(gps.longitude)
    },

    check_in_time: str(p.check_in_time),
    check_out_time: str(p.check_out_time),

    stars: num(first(
      p.extracted_hotel_class,
      p.hotel_class,
      p.stars
    )),

    hotel_class: str(p.hotel_class),

    rating,

    rating_display: rating === null
      ? null
      : rating.toFixed(1),

    review_count: num(first(
      p.reviews,
      p.review_count
    )),

    location_rating: num(p.location_rating),

    reviews_breakdown:
      first(p.reviews_breakdown, null),

    other_reviews:
      first(p.other_reviews, null),

    amenities: arr(p.amenities),

    excluded_amenities:
      arr(p.excluded_amenities),

    amenities_detailed:
      first(p.amenities_detailed, null),

    essential_info:
      first(p.essential_info, null),

    nearby_places: arr(p.nearby_places),

    eco_certified:
      p.eco_certified === true,

    sustainability:
      first(p.sustainability, null),

    accessibility:
      first(p.accessibility, null),

    rate_per_night: nightly,
    total_rate: total,

    price_per_night: nightly.amount,
    total_price: total.amount,

    currency: q.currency,
    nights,

    featured_prices: featured,
    prices,

    booking_options: [
      ...featured,
      ...prices
    ],

    room_options: arr(p.rooms),

    policies: first(p.policies, null),

    images: arr(p.images),

    thumbnail: httpUrl(p.thumbnail),

    raw: p
  };
}

/* ========================================================
   REVIEWER PROFILE PHOTOS
======================================================== */

function normalizeReviewerPhoto(review) {
  const r = obj(review);

  const user = obj(r.user);
  const author = obj(r.author);
  const reviewer = obj(r.reviewer);
  const profile = obj(r.profile);

  const candidates = [
    user.thumbnail,
    user.image,
    user.photo,
    user.avatar,
    user.profile_photo,
    user.profile_picture,
    user.picture,

    author.thumbnail,
    author.image,
    author.photo,
    author.avatar,
    author.profile_picture,

    reviewer.thumbnail,
    reviewer.image,
    reviewer.photo,
    reviewer.avatar,

    profile.thumbnail,
    profile.image,
    profile.photo,

    r.user_thumbnail,
    r.user_image,
    r.author_photo,
    r.author_image,
    r.reviewer_photo,
    r.reviewer_image,
    r.profile_photo,
    r.profile_image,
    r.avatar
  ];

  for (const candidate of candidates) {
    const image = imageUrl(candidate);

    if (image) return image;
  }

  return "";
}

/* ========================================================
   REVIEW PHOTO NORMALIZATION
======================================================== */

function normalizeReviewPhotos(review) {
  const r = obj(review);

  const images = [
    ...photoItems(r.images),
    ...photoItems(r.photos),
    ...photoItems(r.review_images),
    ...photoItems(r.review_photos)
  ];

  return unique(
    images,
    image => image.url
  );
}

/* ========================================================
   GUEST REVIEW NORMALIZATION
======================================================== */

function normalizeReview(value) {
  const r = obj(value);

  const user = obj(r.user);
  const author = obj(r.author);
  const reviewer = obj(r.reviewer);

  const authorName = str(first(
    user.name,
    author.name,
    reviewer.name,
    r.author_name,
    r.reviewer_name,
    typeof r.author === "string"
      ? r.author
      : null
  ));

  const authorPhoto =
    normalizeReviewerPhoto(r);

  const reviewPhotos =
    normalizeReviewPhotos(r);

  return {
    author: authorName,

    author_name: authorName,

    author_url: httpUrl(first(
      user.link,
      author.link,
      reviewer.link,
      r.author_url
    )),

    // Primary field used by Shopify
    author_photo: authorPhoto,

    // Additional frontend-compatible fields
    author_image: authorPhoto,
    user_photo: authorPhoto,
    profile_image: authorPhoto,
    reviewer_photo: authorPhoto,
    reviewer_image: authorPhoto,
    avatar: authorPhoto,

    has_author_photo:
      Boolean(authorPhoto),

    user: {
      ...user,

      name: authorName,

      thumbnail: authorPhoto,
      image: authorPhoto,
      photo: authorPhoto,
      avatar: authorPhoto
    },

    source: str(r.source),

    source_icon:
      httpUrl(r.source_icon),

    rating: num(r.rating),

    best_rating: num(
      r.best_rating
    ),

    date: str(r.date),

    text: str(first(
      r.snippet,
      r.text
    )),

    link: httpUrl(r.link),

    // Guest-uploaded review photographs
    images: reviewPhotos.map(
      photo => photo.url
    ),

    photos: reviewPhotos,

    has_review_photos:
      reviewPhotos.length > 0,

    subratings:
      first(r.subratings, null),

    hotel_highlights:
      arr(r.hotel_highlights),

    review_details: first(
      r.details,
      r.review_details,
      null
    ),

    raw: r
  };
}

function normalizeReviews(data) {
  const d = obj(data);

  const reviews = arr(
    d.reviews
  ).map(normalizeReview);

  return {
    reviews,

    review_count_loaded:
      reviews.length,

    next_page_token: str(first(
      obj(d.serpapi_pagination).next_page_token,
      obj(d.pagination).next_page_token,
      d.next_page_token
    )) || null,

    pagination: first(
      d.serpapi_pagination,
      d.pagination,
      null
    )
  };
}

/* ========================================================
   FETCH UP TO 50 REVIEWS
======================================================== */

async function collectReviews(
  initialData,
  params,
  apiKey
) {
  const initial = normalizeReviews(
    initialData
  );

  const collected = [
    ...initial.reviews
  ];

  const seenTokens = new Set();

  let nextToken =
    initial.next_page_token;

  let pagesLoaded = 1;
  let requestsAttempted = 0;
  let requestsSucceeded = 0;

  const errors = [];

  for (
    let page = 1;
    page < MAX_REVIEW_PAGES &&
    collected.length < MAX_REVIEWS &&
    nextToken;
    page++
  ) {
    if (seenTokens.has(nextToken)) break;

    seenTokens.add(nextToken);
    requestsAttempted++;

    try {
      const nextData = await callSerpApi(
        "google_hotels_reviews",
        {
          ...params,
          next_page_token: nextToken
        },
        apiKey
      );

      requestsSucceeded++;
      pagesLoaded++;

      const parsed = normalizeReviews(
        nextData
      );

      collected.push(
        ...parsed.reviews
      );

      nextToken =
        parsed.next_page_token;

      if (!parsed.reviews.length) break;

    } catch (error) {
      errors.push(
        error.message ||
        "Unable to load additional reviews."
      );

      break;
    }
  }

  const reviews = unique(
    collected,
    review => [
      review.link,
      review.author,
      review.date,
      review.text
    ].join("|")
  ).slice(0, MAX_REVIEWS);

  return {
    reviews,

    review_count_loaded:
      reviews.length,

    next_page_token:
      nextToken,

    pages_loaded:
      pagesLoaded,

    requests_attempted:
      requestsAttempted,

    requests_succeeded:
      requestsSucceeded,

    errors
  };
}

/* ========================================================
   CLEAN RAW RESPONSE
======================================================== */

function cleanRaw(data) {
  return Object.fromEntries(
    Object.entries(obj(data)).filter(
      ([key]) => ![
        "search_metadata",
        "search_parameters",
        "search_information"
      ].includes(key)
    )
  );
}

/* ========================================================
   MAIN VERCEL API HANDLER
======================================================== */

export default async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const apiKey =
    process.env.SERPAPI_API_KEY ||
    process.env.SERPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error:
        "SERPAPI_API_KEY is not configured."
    });
  }

  let q;

  try {
    q = getQuery(req);
    validateQuery(q);

  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  /* PROPERTY REQUEST */

  const propertyParams = {
    property_token: q.property_token,

    q: q.destination,

    check_in_date: q.checkin,
    check_out_date: q.checkout,

    adults: q.adults,
    children: q.children,

    currency: q.currency,

    hl: q.hl,
    gl: q.gl
  };

  if (
    q.children > 0 &&
    q.children_ages
  ) {
    propertyParams.children_ages =
      q.children_ages;
  }

  /* PHOTO REQUEST */

  const photoParams = {
    property_token: q.property_token,
    hl: q.hl
  };

  /* REVIEW REQUEST */

  const reviewParams = {
    property_token: q.property_token,
    hl: q.hl,
    sort_by: 1
  };

  /* THREE CONCURRENT INITIAL REQUESTS */

  const engines = [
    "google_hotels",
    "google_hotels_photos",
    "google_hotels_reviews"
  ];

  const settled = await Promise.allSettled([
    callSerpApi(
      engines[0],
      propertyParams,
      apiKey
    ),

    callSerpApi(
      engines[1],
      photoParams,
      apiKey
    ),

    callSerpApi(
      engines[2],
      reviewParams,
      apiKey
    )
  ]);

  const status = {};
  const data = {};

  for (let i = 0; i < engines.length; i++) {
    const engine = engines[i];
    const result = settled[i];

    if (result.status === "fulfilled") {
      status[engine] = {
        success: true,
        error: null
      };

      data[engine] = result.value;

    } else {
      status[engine] = {
        success: false,

        error:
          result.reason?.message ||
          "Request failed"
      };

      data[engine] = {};
    }
  }

  /* HOTEL DETAILS MUST SUCCEED */

  if (!status.google_hotels.success) {
    return res.status(502).json({
      success: false,

      error:
        "Unable to retrieve hotel property details.",

      property_token:
        q.property_token,

      sources: status
    });
  }

  const propertyData =
    data.google_hotels;

  if (!str(propertyData.name)) {
    return res.status(404).json({
      success: false,

      error:
        "No matching property details were returned.",

      property_token:
        q.property_token,

      sources: status
    });
  }

  /* NORMALIZE HOTEL */

  const hotel = normalizeProperty(
    propertyData,
    q
  );

  /* NORMALIZE PHOTO GALLERY */

  const gallery = normalizePhotos(
    data.google_hotels_photos
  );

  /* ATTACH ROOM-SPECIFIC IMAGES */

  attachRoomImages(
    hotel,
    gallery
  );

  /* RETRIEVE REVIEWS */

  let reviewData = {
    reviews: [],
    review_count_loaded: 0,
    next_page_token: null,
    pages_loaded: 0,
    requests_attempted: 0,
    requests_succeeded: 0,
    errors: []
  };

  if (
    status.google_hotels_reviews.success
  ) {
    reviewData = await collectReviews(
      data.google_hotels_reviews,
      reviewParams,
      apiKey
    );
  }

  /* COMBINE HOTEL PHOTOGRAPHS */

  const propertyImages = photoItems(
    propertyData.images,
    "Property"
  );

  if (hotel.thumbnail) {
    propertyImages.unshift({
      url: hotel.thumbnail,

      original_image:
        hotel.thumbnail,

      thumbnail:
        hotel.thumbnail,

      title: "",
      section: "Property",
      raw: {}
    });
  }

  const allPhotos = unique(
    [
      ...gallery.photos,
      ...propertyImages
    ],
    photo => photo.url
  );

  /* REQUEST STATISTICS */

  const requestsAttempted =
    3 + reviewData.requests_attempted;

  const requestsSucceeded =
    Object.values(status).filter(
      value => value.success
    ).length +
    reviewData.requests_succeeded;

  const reviewerPhotosLoaded =
    reviewData.reviews.filter(
      review => review.has_author_photo
    ).length;

  /* =====================================================
     FINAL SHOPIFY RESPONSE
  ===================================================== */

  return res.status(200).json({

    success: true,

    partial: !(
      status.google_hotels_photos.success &&
      status.google_hotels_reviews.success
    ) || reviewData.errors.length > 0,

    property_token:
      q.property_token,

    /* HOTEL */

    hotel: {
      ...hotel,

      images: allPhotos,

      photos: allPhotos.map(
        photo => photo.url
      ),

      image:
        allPhotos[0]?.url || "",

      image_count:
        allPhotos.length,

      gallery_sections:
        gallery.sections,

      guest_reviews:
        reviewData.reviews,

      reviews_loaded:
        reviewData.review_count_loaded,

      photos_has_more:
        gallery.has_more_photos,

      reviews_next_page_token:
        reviewData.next_page_token
    },

    /* PHOTO GALLERY */

    gallery: {
      photos: allPhotos,

      photo_urls: allPhotos.map(
        photo => photo.url
      ),

      sections:
        gallery.sections,

      photo_count_loaded:
        allPhotos.length,

      has_more_photos:
        gallery.has_more_photos
    },

    /* GUEST REVIEWS */

    reviews: {
      items: reviewData.reviews,

      reviews: reviewData.reviews,

      review_count_loaded:
        reviewData.review_count_loaded,

      total_review_count:
        hotel.review_count,

      reviews_breakdown:
        hotel.reviews_breakdown,

      other_reviews:
        hotel.other_reviews,

      next_page_token:
        reviewData.next_page_token,

      pages_loaded:
        reviewData.pages_loaded,

      reviewer_photos_loaded:
        reviewerPhotosLoaded
    },

    /* PRICING AND ROOMS */

    pricing: {
      currency: hotel.currency,

      nights: hotel.nights,

      rate_per_night:
        hotel.rate_per_night,

      total_rate:
        hotel.total_rate,

      featured_prices:
        hotel.featured_prices,

      prices:
        hotel.prices,

      booking_options:
        hotel.booking_options,

      room_options:
        hotel.room_options
    },

    /* SEARCH INFORMATION */

    search: {
      destination: q.destination,

      checkin: q.checkin,
      checkout: q.checkout,

      rooms: q.rooms,
      adults: q.adults,
      children: q.children,
      babies: q.babies,
      seniors: q.seniors,

      currency: q.currency
    },

    /* ORIGINAL API DATA */

    raw: {
      property: cleanRaw(
        data.google_hotels
      ),

      photos: cleanRaw(
        data.google_hotels_photos
      ),

      reviews: cleanRaw(
        data.google_hotels_reviews
      ),

      review_pages_loaded:
        reviewData.pages_loaded
    },

    /* DEBUGGING INFORMATION */

    meta: {
      source:
        "SerpApi Google Hotels",

      frontend_requests_required: 1,

      serpapi_requests_attempted:
        requestsAttempted,

      serpapi_requests_succeeded:
        requestsSucceeded,

      review_pages_loaded:
        reviewData.pages_loaded,

      reviewer_photos_loaded:
        reviewerPhotosLoaded,

      review_pagination_errors:
        reviewData.errors,

      sources: status,

      has_address:
        hotel.address_available,

      has_photos:
        allPhotos.length > 0,

      has_reviews:
        reviewData.reviews.length > 0,

      has_reviewer_photos:
        reviewerPhotosLoaded > 0,

      room_photos_available:
        hotel.room_options.some(
          room => room.has_room_photos
        ) ||
        hotel.booking_options.some(
          option =>
            option.rooms.some(
              room => room.has_room_photos
            )
        ),

      has_prices:
        hotel.price_per_night !== null ||
        hotel.total_price !== null,

      retrieved_at:
        new Date().toISOString()
    }
  });
}
